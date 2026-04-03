//! # PII / Secret Scrubber — Output Redaction Pipeline
//!
//! Intercepts the stdout/stderr byte stream from the sandbox and replaces any
//! detected secrets, API keys, credentials, or PII with `[REDACTED]` before
//! the data reaches the frontend or is persisted.
//!
//! ## Threat Model
//!
//! An AI agent running in the sandbox might:
//!   1. Accidentally `println!()` an API key or database password.
//!   2. Dump environment variables or config files containing secrets.
//!   3. Generate output that contains PII (emails, SSNs, phone numbers).
//!   4. Attempt to exfiltrate secrets via stdout (since network is air-gapped).
//!
//! The PII scrubber is the **last line of defense** before output leaves the
//! trusted boundary.
//!
//! ## Design
//!
//! ```text
//!   WASM stdout → RingBuffer::write()
//!                      │
//!                      ▼
//!              PiiScrubber::scrub()    ← regex-based pass
//!                      │
//!                      ▼
//!                 Sanitised bytes → API response / SSE stream
//! ```
//!
//! ## Pattern Categories
//!
//! | Category         | Example Pattern                          |
//! |-----------------|------------------------------------------|
//! | OpenAI keys     | `sk-[a-zA-Z0-9]{20,}`                   |
//! | Anthropic keys  | `sk-ant-[a-zA-Z0-9-]{20,}`              |
//! | AWS access keys | `AKIA[0-9A-Z]{16}`                       |
//! | AWS secrets     | 40-char base64-like after "Secret"        |
//! | GitHub tokens   | `gh[ps]_[a-zA-Z0-9]{36,}`               |
//! | Generic secrets | `(key|token|secret|password)=...`        |
//! | Email addresses | RFC 5322-ish local@domain                |
//! | JWT tokens      | `eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.…` |
//! | SSNs            | `\d{3}-\d{2}-\d{4}`                      |
//! | Credit cards    | `\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}`|
//! | Private keys    | `-----BEGIN.*PRIVATE KEY-----`            |
//! | Connection URIs | `(postgres|mysql|redis)://…`              |

use std::borrow::Cow;
use std::sync::OnceLock;

use tracing::{info, warn};

// ─── Redaction Marker ───────────────────────────────────────────────────────

/// The replacement string inserted where secrets were detected.
const REDACTED: &str = "[REDACTED]";

// ─── Pattern Definitions ────────────────────────────────────────────────────

/// A single scrub rule: a compiled regex plus metadata for audit logging.
struct ScrubRule {
    name:    &'static str,
    pattern: regex::Regex,
}

/// Build the master rule set.  Compiled once via `OnceLock`.
fn build_rules() -> Vec<ScrubRule> {
    // Helper: compile a regex or panic (patterns are compile-time constants).
    fn rule(name: &'static str, pat: &str) -> ScrubRule {
        ScrubRule {
            name,
            pattern: regex::Regex::new(pat)
                .unwrap_or_else(|e| panic!("Bad regex for rule '{name}': {e}")),
        }
    }

    vec![
        // ── API Keys ────────────────────────────────────────────────────
        rule(
            "openai_api_key",
            r"sk-[a-zA-Z0-9]{20,}",
        ),
        rule(
            "anthropic_api_key",
            r"sk-ant-[a-zA-Z0-9\-]{20,}",
        ),
        rule(
            "aws_access_key_id",
            r"AKIA[0-9A-Z]{16}",
        ),
        rule(
            "aws_secret_access_key",
            // 40-char base64 string preceded by common key-like context.
            r"(?i)(?:aws_secret_access_key|secret_key|SecretAccessKey)\s*[=:]\s*[A-Za-z0-9/+=]{40}",
        ),
        rule(
            "github_token",
            r"gh[ps]_[a-zA-Z0-9]{36,}",
        ),
        rule(
            "github_fine_grained",
            r"github_pat_[a-zA-Z0-9_]{22,}",
        ),
        rule(
            "google_api_key",
            r"AIza[0-9A-Za-z\-_]{35}",
        ),
        rule(
            "stripe_key",
            r"(?:sk|pk)_(?:test|live)_[0-9a-zA-Z]{24,}",
        ),
        rule(
            "slack_token",
            r"xox[bprs]-[0-9a-zA-Z\-]{10,}",
        ),

        // ── Generic key=value secrets ───────────────────────────────────
        rule(
            "generic_secret_assignment",
            // Match: KEY=value, TOKEN=value, PASSWORD=value, SECRET=value
            // where value is a non-whitespace string of 8+ chars.
            r"(?i)(?:api_key|api_secret|access_token|auth_token|secret_key|password|passwd|private_key|client_secret|database_url|db_password)\s*[=:]\s*\S{8,}",
        ),

        // ── JWT Tokens ──────────────────────────────────────────────────
        rule(
            "jwt_token",
            r"eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}",
        ),

        // ── Private Key Blocks ──────────────────────────────────────────
        rule(
            "private_key_header",
            r"-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----",
        ),

        // ── Connection Strings / URIs ───────────────────────────────────
        rule(
            "connection_uri",
            r"(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|amqp|mssql)://[^\s'\"]+",
        ),

        // ── PII: Email Addresses ────────────────────────────────────────
        rule(
            "email_address",
            r"[a-zA-Z0-9._%+\-]{2,}@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}",
        ),

        // ── PII: US Social Security Numbers ─────────────────────────────
        rule(
            "us_ssn",
            r"\b\d{3}-\d{2}-\d{4}\b",
        ),

        // ── PII: Credit Card Numbers (basic Luhn-eligible patterns) ─────
        rule(
            "credit_card",
            r"\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b",
        ),

        // ── PII: US Phone Numbers ───────────────────────────────────────
        rule(
            "us_phone",
            r"\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b",
        ),

        // ── Bearer Tokens in HTTP headers ───────────────────────────────
        rule(
            "bearer_token",
            r"(?i)(?:Bearer|Authorization)\s+[a-zA-Z0-9._\-]{20,}",
        ),
    ]
}

/// Globally compiled rule set (initialised once on first use).
static RULES: OnceLock<Vec<ScrubRule>> = OnceLock::new();

fn rules() -> &'static Vec<ScrubRule> {
    RULES.get_or_init(build_rules)
}

// ─── Scrubber ───────────────────────────────────────────────────────────────

/// Statistics from a single scrub pass.
#[derive(Debug, Clone, Default)]
pub struct ScrubStats {
    /// Total number of redactions performed.
    pub redactions: usize,
    /// Names of rules that matched (for audit logging).
    pub matched_rules: Vec<&'static str>,
}

/// The main PII / secret scrubber.
///
/// Stateless and thread-safe.  Call `scrub()` on any byte slice to get a
/// sanitised version.
pub struct PiiScrubber;

impl PiiScrubber {
    /// Scrub a UTF-8 string, returning a sanitised copy and statistics.
    ///
    /// Non-UTF-8 bytes are replaced with U+FFFD by `String::from_utf8_lossy`
    /// before pattern matching.
    pub fn scrub(input: &str) -> (String, ScrubStats) {
        let mut output = input.to_string();
        let mut stats = ScrubStats::default();

        for rule in rules() {
            // Count matches in the *current* output (which may already have
            // redactions from earlier rules).  This avoids double-counting.
            let match_count = rule.pattern.find_iter(&output).count();
            if match_count > 0 {
                output = rule.pattern.replace_all(&output, REDACTED).into_owned();
                stats.redactions += match_count;
                stats.matched_rules.push(rule.name);
            }
        }

        if stats.redactions > 0 {
            warn!(
                redactions    = stats.redactions,
                matched_rules = ?stats.matched_rules,
                "PII scrubber redacted secrets from sandbox output"
            );
        }

        (output, stats)
    }

    /// Scrub raw bytes (lossy UTF-8 decode → scrub → re-encode).
    pub fn scrub_bytes(input: &[u8]) -> (Vec<u8>, ScrubStats) {
        let text = String::from_utf8_lossy(input);
        let (scrubbed, stats) = Self::scrub(&text);
        (scrubbed.into_bytes(), stats)
    }

    /// Returns `true` if the input contains any detectable secrets.
    /// Cheaper than a full scrub when you only need a yes/no answer.
    pub fn contains_secrets(input: &str) -> bool {
        rules().iter().any(|rule| rule.pattern.is_match(input))
    }
}

// ─── Middleware Integration ─────────────────────────────────────────────────

/// Apply scrubbing to an `ExecuteResponse` stdout/stderr before returning
/// it to the caller.
///
/// This function is designed to be called in the API handler **after**
/// execution completes but **before** the JSON response is serialised.
pub fn scrub_execution_output(
    stdout: &str,
    stderr: &str,
) -> (String, String, ScrubStats) {
    let (scrubbed_stdout, mut stats) = PiiScrubber::scrub(stdout);
    let (scrubbed_stderr, stderr_stats) = PiiScrubber::scrub(stderr);

    stats.redactions += stderr_stats.redactions;
    stats.matched_rules.extend(stderr_stats.matched_rules);

    if stats.redactions > 0 {
        info!(
            stdout_redactions = stats.redactions - stderr_stats.redactions,
            stderr_redactions = stderr_stats.redactions,
            "Output scrubbed before API response"
        );
    }

    (scrubbed_stdout, scrubbed_stderr, stats)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_openai_key() {
        let input = "Using key sk-abcdefghijklmnopqrstuvwxyz123456 for API call";
        let (scrubbed, stats) = PiiScrubber::scrub(input);
        assert!(scrubbed.contains(REDACTED));
        assert!(!scrubbed.contains("sk-abcdefghij"));
        assert!(stats.redactions > 0);
        assert!(stats.matched_rules.contains(&"openai_api_key"));
    }

    #[test]
    fn detects_anthropic_key() {
        let input = "export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
        let (scrubbed, stats) = PiiScrubber::scrub(input);
        assert!(scrubbed.contains(REDACTED));
        assert!(!scrubbed.contains("sk-ant-"));
    }

    #[test]
    fn detects_aws_access_key() {
        let input = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
        let (scrubbed, stats) = PiiScrubber::scrub(input);
        assert!(scrubbed.contains(REDACTED));
        assert!(!scrubbed.contains("AKIAIOSFODNN7EXAMPLE"));
    }

    #[test]
    fn detects_aws_secret_key() {
        let input = "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
        let (scrubbed, stats) = PiiScrubber::scrub(input);
        assert!(scrubbed.contains(REDACTED));
        assert!(!scrubbed.contains("wJalrXUtnFEMI"));
    }

    #[test]
    fn detects_github_token() {
        let input = "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
        let (scrubbed, stats) = PiiScrubber::scrub(input);
        assert!(scrubbed.contains(REDACTED));
        assert!(!scrubbed.contains("ghp_"));
    }

    #[test]
    fn detects_jwt_token() {
        let input = "Authorization: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        let (scrubbed, stats) = PiiScrubber::scrub(input);
        assert!(scrubbed.contains(REDACTED));
        assert!(!scrubbed.contains("eyJhbGci"));
    }

    #[test]
    fn detects_connection_string() {
        let input = "DATABASE_URL=postgres://admin:s3cret@db.example.com:5432/mydb";
        let (scrubbed, stats) = PiiScrubber::scrub(input);
        assert!(scrubbed.contains(REDACTED));
        assert!(!scrubbed.contains("s3cret"));
    }

    #[test]
    fn detects_email() {
        let input = "Contact: alice.smith@example.com for details";
        let (scrubbed, stats) = PiiScrubber::scrub(input);
        assert!(scrubbed.contains(REDACTED));
        assert!(!scrubbed.contains("alice.smith@example.com"));
    }

    #[test]
    fn detects_ssn() {
        let input = "SSN: 123-45-6789";
        let (scrubbed, stats) = PiiScrubber::scrub(input);
        assert!(scrubbed.contains(REDACTED));
        assert!(!scrubbed.contains("123-45-6789"));
    }

    #[test]
    fn detects_credit_card() {
        let input = "Card: 4111-1111-1111-1111";
        let (scrubbed, stats) = PiiScrubber::scrub(input);
        assert!(scrubbed.contains(REDACTED));
        assert!(!scrubbed.contains("4111"));
    }

    #[test]
    fn detects_private_key_header() {
        let input = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...";
        let (scrubbed, stats) = PiiScrubber::scrub(input);
        assert!(scrubbed.contains(REDACTED));
    }

    #[test]
    fn detects_generic_secret_assignment() {
        let input = "password=MyS3cretP@ssw0rd!";
        let (scrubbed, stats) = PiiScrubber::scrub(input);
        assert!(scrubbed.contains(REDACTED));
        assert!(!scrubbed.contains("MyS3cretP@ssw0rd!"));
    }

    #[test]
    fn preserves_clean_output() {
        let input = "Hello from Isolator-V WASM!\nExecution complete.\n";
        let (scrubbed, stats) = PiiScrubber::scrub(input);
        assert_eq!(scrubbed, input);
        assert_eq!(stats.redactions, 0);
        assert!(stats.matched_rules.is_empty());
    }

    #[test]
    fn handles_multiple_secrets_in_one_pass() {
        let input = "key=sk-abcdefghijklmnopqrstuvwxyz123456 email=test@example.com ssn=111-22-3333";
        let (scrubbed, stats) = PiiScrubber::scrub(input);
        // All three should be redacted.
        assert!(!scrubbed.contains("sk-abcdefghij"));
        assert!(!scrubbed.contains("test@example.com"));
        assert!(!scrubbed.contains("111-22-3333"));
    }

    #[test]
    fn contains_secrets_fast_check() {
        assert!(PiiScrubber::contains_secrets("sk-abcdefghijklmnopqrstuvwxyz123456"));
        assert!(!PiiScrubber::contains_secrets("Hello, world!"));
    }

    #[test]
    fn scrub_bytes_works() {
        let input = b"key: sk-abcdefghijklmnopqrstuvwxyz123456";
        let (scrubbed, stats) = PiiScrubber::scrub_bytes(input);
        let text = String::from_utf8(scrubbed).unwrap();
        assert!(text.contains(REDACTED));
        assert!(stats.redactions > 0);
    }

    #[test]
    fn scrub_execution_output_works() {
        let stdout = "Result: sk-abcdefghijklmnopqrstuvwxyz123456";
        let stderr = "Error: connection to postgres://admin:pw@host/db failed";
        let (out, err, stats) = scrub_execution_output(stdout, stderr);
        assert!(out.contains(REDACTED));
        assert!(err.contains(REDACTED));
        assert!(stats.redactions >= 2);
    }

    #[test]
    fn detects_bearer_token() {
        let input = "Authorization Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9abc123";
        let (scrubbed, stats) = PiiScrubber::scrub(input);
        assert!(scrubbed.contains(REDACTED));
    }

    #[test]
    fn detects_stripe_key() {
        let input = &format!("{}{}", "sk_live_", "abcdefghijklmnopqrstuvwxyz");
        let (scrubbed, stats) = PiiScrubber::scrub(input);
        assert!(scrubbed.contains(REDACTED));
    }
}
