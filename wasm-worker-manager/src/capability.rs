//! # WASM Capability Validator — Object-Capability (OCAP) Security
//!
//! Implements a zero-trust execution model: the WASM guest has **zero** inherent
//! rights.  Every WASI syscall is validated against a `SessionPolicy` manifest
//! before the host executes it.
//!
//! ## Design
//!
//! ```text
//!   WASM Guest
//!       │  fd_write(fd=3, data)
//!       ▼
//!  ┌─────────────────────────┐
//!  │   CapabilityValidator   │  ← checks SessionPolicy
//!  │                         │
//!  │  "Is fd_write allowed?" │──► Yes → forward to VFS
//!  │  "Is /etc/passwd open?" │──► No  → return EACCES
//!  └─────────────────────────┘
//! ```
//!
//! ## Policy Model
//!
//! Each session receives a `SessionPolicy` at instantiation time.  Policies are
//! additive: capabilities not explicitly granted are denied.  This is the
//! Object-Capability principle — possession of a capability handle is the sole
//! basis for authority.

use std::collections::HashSet;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::error::{Result, SandboxError};

// ─── WASI Capability Identifiers ────────────────────────────────────────────

/// Enumeration of every WASI syscall we intercept.
/// Each variant maps to a single `wasi_snapshot_preview1` export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WasiCapability {
    // ── File I/O ────────────────────────────────────────────────────────
    FdRead,
    FdWrite,
    FdSeek,
    FdClose,
    FdFilestatGet,
    FdFdstatGet,
    PathOpen,

    // ── Process lifecycle ───────────────────────────────────────────────
    ProcExit,

    // ── Environment ─────────────────────────────────────────────────────
    EnvironGet,
    EnvironSizesGet,
    ArgsGet,
    ArgsSizesGet,

    // ── Clock ───────────────────────────────────────────────────────────
    ClockTimeGet,

    // ── Scheduling ──────────────────────────────────────────────────────
    SchedYield,

    // ── Randomness ──────────────────────────────────────────────────────
    RandomGet,

    // ── Networking (always denied by default) ───────────────────────────
    SockAccept,
    SockRecv,
    SockSend,
    SockShutdown,
}

impl WasiCapability {
    /// Returns the WASI import name (e.g. `"fd_write"`).
    pub fn wasi_name(&self) -> &'static str {
        match self {
            Self::FdRead          => "fd_read",
            Self::FdWrite         => "fd_write",
            Self::FdSeek          => "fd_seek",
            Self::FdClose         => "fd_close",
            Self::FdFilestatGet   => "fd_filestat_get",
            Self::FdFdstatGet     => "fd_fdstat_get",
            Self::PathOpen        => "path_open",
            Self::ProcExit        => "proc_exit",
            Self::EnvironGet      => "environ_get",
            Self::EnvironSizesGet => "environ_sizes_get",
            Self::ArgsGet         => "args_get",
            Self::ArgsSizesGet    => "args_sizes_get",
            Self::ClockTimeGet    => "clock_time_get",
            Self::SchedYield      => "sched_yield",
            Self::RandomGet       => "random_get",
            Self::SockAccept      => "sock_accept",
            Self::SockRecv        => "sock_recv",
            Self::SockSend        => "sock_send",
            Self::SockShutdown    => "sock_shutdown",
        }
    }
}

// ─── Path Access Control ────────────────────────────────────────────────────

/// Controls which VFS paths a session is allowed to access.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathPolicy {
    /// Paths the session may read from (glob-style prefixes).
    /// Example: `["/workspace", "/tmp"]`
    pub readable_prefixes: Vec<String>,

    /// Paths the session may write to (glob-style prefixes).
    /// Example: `["/workspace"]`
    pub writable_prefixes: Vec<String>,

    /// Explicit deny-list (takes priority over allow-list).
    /// Example: `["/workspace/.env", "/workspace/credentials.json"]`
    pub denied_paths: Vec<String>,
}

impl Default for PathPolicy {
    fn default() -> Self {
        Self {
            readable_prefixes: vec![
                "/workspace".to_string(),
                "/tmp".to_string(),
            ],
            writable_prefixes: vec![
                "/workspace".to_string(),
                "/tmp".to_string(),
            ],
            denied_paths: vec![
                "/workspace/.env".to_string(),
                "/workspace/.env.local".to_string(),
                "/workspace/credentials.json".to_string(),
                "/workspace/.git/config".to_string(),
            ],
        }
    }
}

impl PathPolicy {
    /// Check if `path` (already canonicalised) is readable under this policy.
    pub fn can_read(&self, path: &str) -> bool {
        if self.is_denied(path) {
            return false;
        }
        self.readable_prefixes.iter().any(|pfx| path.starts_with(pfx))
    }

    /// Check if `path` (already canonicalised) is writable under this policy.
    pub fn can_write(&self, path: &str) -> bool {
        if self.is_denied(path) {
            return false;
        }
        self.writable_prefixes.iter().any(|pfx| path.starts_with(pfx))
    }

    fn is_denied(&self, path: &str) -> bool {
        self.denied_paths.iter().any(|dp| path == dp || path.starts_with(&format!("{dp}/")))
    }
}

// ─── Network Egress Policy ──────────────────────────────────────────────────

/// Controls network egress (default: air-gapped / all denied).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkPolicy {
    /// If `false` (default), all socket operations return ENOTSUP.
    pub egress_allowed: bool,

    /// If egress is allowed, only these destination domains/IPs are reachable.
    /// An empty list with `egress_allowed = true` means "allow all" (not recommended).
    #[serde(default)]
    pub allowed_destinations: Vec<String>,

    /// Maximum bytes the session may send over the network.
    #[serde(default = "default_egress_quota")]
    pub egress_quota_bytes: u64,
}

fn default_egress_quota() -> u64 { 0 }

impl Default for NetworkPolicy {
    /// Default: fully air-gapped.
    fn default() -> Self {
        Self {
            egress_allowed:       false,
            allowed_destinations: Vec::new(),
            egress_quota_bytes:   0,
        }
    }
}

// ─── Resource Quota Policy ──────────────────────────────────────────────────

/// Hard resource caps for a single session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceQuota {
    /// Maximum WASM linear memory in bytes.
    #[serde(default = "default_mem")]
    pub memory_limit_bytes: usize,

    /// Maximum CPU wall-clock time in milliseconds.
    #[serde(default = "default_cpu")]
    pub cpu_quota_ms: u64,

    /// Maximum bytes the session may write to the VFS.
    #[serde(default = "default_vfs_quota")]
    pub vfs_write_quota_bytes: u64,

    /// Maximum number of simultaneously open file descriptors.
    #[serde(default = "default_max_fds")]
    pub max_open_fds: usize,
}

fn default_mem()       -> usize { 50 * 1024 * 1024 }  // 50 MB
fn default_cpu()       -> u64   { 2_000 }             // 2 seconds
fn default_vfs_quota() -> u64   { 64 * 1024 * 1024 }  // 64 MB
fn default_max_fds()   -> usize { 256 }

impl Default for ResourceQuota {
    fn default() -> Self {
        Self {
            memory_limit_bytes:    default_mem(),
            cpu_quota_ms:          default_cpu(),
            vfs_write_quota_bytes: default_vfs_quota(),
            max_open_fds:          default_max_fds(),
        }
    }
}

// ─── Environment Variable Policy ────────────────────────────────────────────

/// Controls which (if any) environment variables are visible to the guest.
/// By default: zero variables are exposed (Least Privilege).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EnvPolicy {
    /// Scoped key-value pairs visible to the guest.
    /// Keys are validated against an allow-list; no host env-vars leak.
    #[serde(default)]
    pub allowed_vars: Vec<(String, String)>,
}

// ─── Session Policy (Capability Manifest) ───────────────────────────────────

/// The complete capability manifest for a single execution session.
///
/// This is the sole source of authority: capabilities not granted here do not
/// exist for the guest.  The manifest is immutable once a session begins.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionPolicy {
    /// Human-readable label (for audit logs).
    pub label: String,

    /// Set of WASI syscalls the session is allowed to invoke.
    pub allowed_capabilities: HashSet<WasiCapability>,

    /// File path access control.
    #[serde(default)]
    pub paths: PathPolicy,

    /// Network egress control.
    #[serde(default)]
    pub network: NetworkPolicy,

    /// Resource quotas.
    #[serde(default)]
    pub resources: ResourceQuota,

    /// Environment variable exposure.
    #[serde(default)]
    pub env: EnvPolicy,
}

impl Default for SessionPolicy {
    /// Restrictive default: only safe capabilities granted.
    fn default() -> Self {
        let mut caps = HashSet::new();
        // Safe defaults: file I/O to sandboxed VFS, process lifecycle, clock.
        caps.insert(WasiCapability::FdRead);
        caps.insert(WasiCapability::FdWrite);
        caps.insert(WasiCapability::FdSeek);
        caps.insert(WasiCapability::FdClose);
        caps.insert(WasiCapability::FdFilestatGet);
        caps.insert(WasiCapability::FdFdstatGet);
        caps.insert(WasiCapability::PathOpen);
        caps.insert(WasiCapability::ProcExit);
        caps.insert(WasiCapability::ClockTimeGet);
        caps.insert(WasiCapability::SchedYield);
        caps.insert(WasiCapability::RandomGet);
        // Deliberately NOT included: EnvironGet, ArgsGet, Sock*

        Self {
            label:                "default".to_string(),
            allowed_capabilities: caps,
            paths:                PathPolicy::default(),
            network:              NetworkPolicy::default(),
            resources:            ResourceQuota::default(),
            env:                  EnvPolicy::default(),
        }
    }
}

// ─── Capability Validator ───────────────────────────────────────────────────

/// The runtime validator that checks every WASI call against the session policy.
///
/// One `CapabilityValidator` is created per sandbox session.  It is stored in
/// the `SandboxData` (Wasmtime `Store` data) and consulted by every intercepted
/// WASI host function **before** the real implementation executes.
#[derive(Debug)]
pub struct CapabilityValidator {
    policy: Arc<SessionPolicy>,
    /// Monotonic counter of denied calls (for alerting / metrics).
    denied_count: std::sync::atomic::AtomicU64,
}

impl Clone for CapabilityValidator {
    fn clone(&self) -> Self {
        Self {
            policy: Arc::clone(&self.policy),
            denied_count: std::sync::atomic::AtomicU64::new(
                self.denied_count.load(std::sync::atomic::Ordering::Relaxed),
            ),
        }
    }
}

impl CapabilityValidator {
    /// Create a new validator from an immutable session policy.
    pub fn new(policy: Arc<SessionPolicy>) -> Self {
        Self {
            policy,
            denied_count: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// Returns the underlying policy (read-only).
    pub fn policy(&self) -> &SessionPolicy {
        &self.policy
    }

    /// Total number of denied calls in this session.
    pub fn denied_count(&self) -> u64 {
        self.denied_count.load(std::sync::atomic::Ordering::Relaxed)
    }

    // ── Syscall-level checks ────────────────────────────────────────────────

    /// Validate that a WASI capability is allowed by this session's policy.
    ///
    /// Returns `Ok(())` if the capability is granted, or
    /// `Err(CapabilityDenied)` with an audit-log message if denied.
    pub fn check_capability(&self, cap: WasiCapability) -> Result<()> {
        if self.policy.allowed_capabilities.contains(&cap) {
            Ok(())
        } else {
            self.denied_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            warn!(
                label      = %self.policy.label,
                capability = %cap.wasi_name(),
                denied     = self.denied_count(),
                "Capability denied"
            );
            Err(SandboxError::CapabilityDenied {
                capability: format!(
                    "wasi_snapshot_preview1::{} is not granted for session '{}'",
                    cap.wasi_name(),
                    self.policy.label,
                ),
            })
        }
    }

    // ── Path-level checks ───────────────────────────────────────────────────

    /// Validate that a path_open call is allowed under the path policy.
    ///
    /// `canonical_path` must already be canonicalised (no `..` or `.` segments).
    /// `wants_write` indicates whether WRITE rights are requested.
    pub fn check_path_open(&self, canonical_path: &str, wants_write: bool) -> Result<()> {
        // First: is the capability itself allowed?
        self.check_capability(WasiCapability::PathOpen)?;

        // Then: is the specific path allowed?
        if wants_write {
            if !self.policy.paths.can_write(canonical_path) {
                self.denied_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                warn!(
                    label = %self.policy.label,
                    path  = canonical_path,
                    "Write access denied by path policy"
                );
                return Err(SandboxError::CapabilityDenied {
                    capability: format!("write access to '{canonical_path}'"),
                });
            }
        } else if !self.policy.paths.can_read(canonical_path) {
            self.denied_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            warn!(
                label = %self.policy.label,
                path  = canonical_path,
                "Read access denied by path policy"
            );
            return Err(SandboxError::CapabilityDenied {
                capability: format!("read access to '{canonical_path}'"),
            });
        }

        Ok(())
    }

    // ── Network-level checks ────────────────────────────────────────────────

    /// Validate that network egress is permitted (always `Err` by default).
    pub fn check_network_egress(&self, destination: Option<&str>) -> Result<()> {
        if !self.policy.network.egress_allowed {
            self.denied_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            warn!(
                label       = %self.policy.label,
                destination = destination.unwrap_or("unknown"),
                "Network egress denied — air-gapped policy"
            );
            return Err(SandboxError::CapabilityDenied {
                capability: "network egress (sandbox is air-gapped)".to_string(),
            });
        }

        // If egress is allowed, validate destination against allow-list.
        if let Some(dest) = destination {
            if !self.policy.network.allowed_destinations.is_empty()
                && !self.policy.network.allowed_destinations.iter().any(|d| dest.contains(d))
            {
                self.denied_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                warn!(
                    label       = %self.policy.label,
                    destination = dest,
                    "Network egress denied — destination not in allow-list"
                );
                return Err(SandboxError::CapabilityDenied {
                    capability: format!("network egress to '{dest}' (not in allow-list)"),
                });
            }
        }

        Ok(())
    }

    // ── Environment variable checks ─────────────────────────────────────────

    /// Return the environment variables visible to the guest.
    /// Returns an empty list unless `environ_get` is in the capability set
    /// AND the policy includes specific allowed_vars.
    pub fn visible_env_vars(&self) -> &[(String, String)] {
        if self.policy.allowed_capabilities.contains(&WasiCapability::EnvironGet) {
            &self.policy.env.allowed_vars
        } else {
            &[]
        }
    }
}

// ─── Pre-built policy templates ─────────────────────────────────────────────

impl SessionPolicy {
    /// Minimal policy for untrusted agent code: VFS-only, air-gapped, no env.
    pub fn untrusted(label: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            ..Default::default()
        }
    }

    /// Slightly more permissive: allows scoped env vars and longer CPU quota.
    pub fn trusted_agent(label: impl Into<String>, env_vars: Vec<(String, String)>) -> Self {
        let mut policy = Self::default();
        policy.label = label.into();
        policy.resources.cpu_quota_ms = 10_000; // 10 seconds
        policy.resources.memory_limit_bytes = 100 * 1024 * 1024; // 100 MB
        policy.allowed_capabilities.insert(WasiCapability::EnvironGet);
        policy.allowed_capabilities.insert(WasiCapability::EnvironSizesGet);
        policy.env.allowed_vars = env_vars;
        policy
    }

    /// Maximum lockdown: only proc_exit and clock.  No file I/O at all.
    pub fn compute_only(label: impl Into<String>) -> Self {
        let mut caps = HashSet::new();
        caps.insert(WasiCapability::ProcExit);
        caps.insert(WasiCapability::ClockTimeGet);
        caps.insert(WasiCapability::FdWrite); // stdout/stderr only
        caps.insert(WasiCapability::SchedYield);

        Self {
            label: label.into(),
            allowed_capabilities: caps,
            paths: PathPolicy {
                readable_prefixes: Vec::new(),
                writable_prefixes: Vec::new(),
                denied_paths:      Vec::new(),
            },
            network:   NetworkPolicy::default(),
            resources: ResourceQuota::default(),
            env:       EnvPolicy::default(),
        }
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_allows_fd_write() {
        let policy = Arc::new(SessionPolicy::default());
        let validator = CapabilityValidator::new(policy);
        assert!(validator.check_capability(WasiCapability::FdWrite).is_ok());
    }

    #[test]
    fn default_policy_denies_sock_send() {
        let policy = Arc::new(SessionPolicy::default());
        let validator = CapabilityValidator::new(policy);
        let result = validator.check_capability(WasiCapability::SockSend);
        assert!(result.is_err());
        assert_eq!(validator.denied_count(), 1);
    }

    #[test]
    fn default_policy_denies_environ_get() {
        let policy = Arc::new(SessionPolicy::default());
        let validator = CapabilityValidator::new(policy);
        assert!(validator.check_capability(WasiCapability::EnvironGet).is_err());
    }

    #[test]
    fn path_policy_allows_workspace() {
        let policy = Arc::new(SessionPolicy::default());
        let validator = CapabilityValidator::new(policy);
        assert!(validator.check_path_open("/workspace/data.txt", false).is_ok());
        assert!(validator.check_path_open("/workspace/data.txt", true).is_ok());
    }

    #[test]
    fn path_policy_denies_etc() {
        let policy = Arc::new(SessionPolicy::default());
        let validator = CapabilityValidator::new(policy);
        assert!(validator.check_path_open("/etc/passwd", false).is_err());
    }

    #[test]
    fn path_policy_denies_env_file() {
        let policy = Arc::new(SessionPolicy::default());
        let validator = CapabilityValidator::new(policy);
        assert!(validator.check_path_open("/workspace/.env", true).is_err());
        assert!(validator.check_path_open("/workspace/credentials.json", true).is_err());
    }

    #[test]
    fn network_policy_default_denies_all() {
        let policy = Arc::new(SessionPolicy::default());
        let validator = CapabilityValidator::new(policy);
        assert!(validator.check_network_egress(Some("api.openai.com")).is_err());
    }

    #[test]
    fn network_policy_with_allowlist() {
        let mut policy = SessionPolicy::default();
        policy.network.egress_allowed = true;
        policy.network.allowed_destinations = vec!["api.example.com".to_string()];
        let validator = CapabilityValidator::new(Arc::new(policy));
        assert!(validator.check_network_egress(Some("api.example.com")).is_ok());
        assert!(validator.check_network_egress(Some("evil.com")).is_err());
    }

    #[test]
    fn compute_only_denies_path_open() {
        let policy = Arc::new(SessionPolicy::compute_only("test"));
        let validator = CapabilityValidator::new(policy);
        assert!(validator.check_capability(WasiCapability::PathOpen).is_err());
        assert!(validator.check_capability(WasiCapability::FdWrite).is_ok());
    }

    #[test]
    fn trusted_agent_allows_env() {
        let vars = vec![("API_KEY".to_string(), "sk-test-***".to_string())];
        let policy = Arc::new(SessionPolicy::trusted_agent("agent-7", vars));
        let validator = CapabilityValidator::new(policy);
        assert!(validator.check_capability(WasiCapability::EnvironGet).is_ok());
        assert_eq!(validator.visible_env_vars().len(), 1);
    }

    #[test]
    fn denied_count_increments() {
        let policy = Arc::new(SessionPolicy::compute_only("test"));
        let validator = CapabilityValidator::new(policy);
        assert_eq!(validator.denied_count(), 0);
        let _ = validator.check_capability(WasiCapability::PathOpen);
        let _ = validator.check_capability(WasiCapability::FdRead);
        assert_eq!(validator.denied_count(), 2);
    }

    #[test]
    fn session_policy_serialises_roundtrip() {
        let policy = SessionPolicy::default();
        let json = serde_json::to_string_pretty(&policy).unwrap();
        let parsed: SessionPolicy = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.label, policy.label);
        assert_eq!(parsed.allowed_capabilities.len(), policy.allowed_capabilities.len());
    }
}
