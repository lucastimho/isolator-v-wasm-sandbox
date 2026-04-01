//! # Error Types
//!
//! All failure modes for the WASM Worker Manager, expressed as a single
//! exhaustive enum so callers can pattern-match without stringly-typed checks.

use thiserror::Error;

// ─── Public result alias ────────────────────────────────────────────────────

pub type Result<T, E = SandboxError> = std::result::Result<T, E>;

// ─── Error enum ─────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum SandboxError {
    // ── Pool / lifecycle ────────────────────────────────────────────────────

    /// The warm pool is fully checked out; caller should retry or queue.
    #[error("Pool exhausted: all {capacity} sandbox slots are in use")]
    PoolExhausted { capacity: usize },

    /// A sandbox was requested by ID but is no longer registered.
    #[error("Sandbox '{id}' not found in the inflight registry")]
    NotFound { id: String },

    /// Pre-warm or first-compilation step failed during engine setup.
    #[error("Engine initialisation failed: {reason}")]
    EngineInit { reason: String },

    // ── Execution ───────────────────────────────────────────────────────────

    /// The Wasmtime epoch deadline fired — guest exceeded CPU quota.
    #[error("CPU quota exceeded: sandbox ran longer than {limit_ms}ms")]
    CpuQuotaExceeded { limit_ms: u64 },

    /// Guest tried to grow linear memory beyond the 50 MB RSS hard cap.
    #[error("Memory limit exceeded: requested {requested_mb:.1}MB, cap is {limit_mb}MB")]
    MemoryLimitExceeded { requested_mb: f64, limit_mb: usize },

    /// The RSS watchdog observed the host process exceeding the 50 MB per-sandbox budget.
    #[error("RSS watchdog killed sandbox '{id}': {rss_mb:.1}MB > {limit_mb}MB")]
    RssLimitExceeded {
        id:       String,
        rss_mb:   f64,
        limit_mb: usize,
    },

    /// Guest triggered an explicit `proc_exit` with non-zero status.
    #[error("Sandbox exited with non-zero status {code}")]
    GuestExit { code: i32 },

    /// Catch-all for Wasmtime trap / anyhow errors that don't map to a
    /// specific variant above.
    #[error("WASM trap: {0}")]
    Trap(#[from] anyhow::Error),

    // ── Virtual File System ─────────────────────────────────────────────────

    /// Guest attempted to open a path that does not exist in the VFS and
    /// `O_CREAT` was not set.
    #[error("VFS: path not found — '{path}'")]
    VfsNotFound { path: String },

    /// Guest attempted to write to a read-only file descriptor.
    #[error("VFS: file descriptor {fd} is not writable")]
    VfsReadOnly { fd: u32 },

    /// Guest opened too many file descriptors simultaneously.
    #[error("VFS: file descriptor table exhausted (max {max})")]
    VfsFdExhausted { max: usize },

    /// VFS internal consistency error (should never surface to callers).
    #[error("VFS internal error: {msg}")]
    VfsInternal { msg: String },

    // ── Security / privilege ────────────────────────────────────────────────

    /// Guest attempted to access a host capability that was not granted
    /// (e.g. network socket, environment variable, real file path).
    #[error("Capability denied: '{capability}' is not available in this sandbox")]
    CapabilityDenied { capability: String },

    // ── Concurrency ─────────────────────────────────────────────────────────

    /// An internal channel send/recv failed — indicates a bug in the manager.
    #[error("Internal channel error: {0}")]
    Channel(String),
}

// ─── Convenience conversions ─────────────────────────────────────────────────

impl SandboxError {
    /// Map WASI errno values (i32) back to a descriptive error for logging.
    pub fn wasi_errno_name(errno: i32) -> &'static str {
        match errno {
            0  => "SUCCESS",
            1  => "TOOBIG",
            2  => "ACCES",
            4  => "BADF",
            8  => "BUSY",
            9  => "CHILD",
            11 => "DEADLK",
            16 => "EXIST",
            20 => "FBIG",
            21 => "ILSEQ",
            22 => "INPROGRESS",
            23 => "INTR",
            24 => "INVAL",
            27 => "IO",
            28 => "ISCONN",
            29 => "ISDIR",
            44 => "NOENT",
            48 => "NOMEM",
            52 => "NOSPC",
            58 => "NOTSUP",
            63 => "OVERFLOW",
            70 => "ROFS",
            73 => "TIMEDOUT",
            _  => "UNKNOWN",
        }
    }

    /// Returns `true` if this error should trigger a sandbox slot eviction
    /// rather than a simple error response to the caller.
    pub fn is_fatal(&self) -> bool {
        matches!(
            self,
            SandboxError::RssLimitExceeded { .. }
                | SandboxError::EngineInit { .. }
                | SandboxError::VfsInternal { .. }
                | SandboxError::Channel(_)
        )
    }
}
