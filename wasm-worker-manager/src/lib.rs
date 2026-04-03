//! # wasm-worker-manager — Library Root
//!
//! Re-exports the core public API so the crate can be used both as a binary
//! (via `src/main.rs`) and as a library dependency in integration tests or
//! downstream orchestration crates.
//!
//! ## Module map
//!
//! ```text
//! wasm_worker_manager
//! ├── error            — SandboxError + Result alias
//! ├── vfs              — In-memory WASI VFS (BTreeMap + RingBuffer)
//! ├── sandbox_pool     — SandboxPool, PoolConfig, ExecutionResult
//! ├── resource_monitor — ResourceMonitor, SandboxResourceLimiter, epoch ticker
//! ├── api              — Axum router, AppState, SSE bridge
//! ├── capability       — OCAP-based WASI capability validator + SessionPolicy
//! ├── seccomp_guard    — Host-level seccomp BPF syscall filter
//! ├── pii_scrubber     — Regex-based PII / secret redaction pipeline
//! └── backpressure     — Adaptive load shedding (503 + Retry-After)
//! ```

#![warn(clippy::all, clippy::pedantic)]
#![allow(clippy::module_name_repetitions)]

pub mod error;
pub mod resource_monitor;
pub mod sandbox_pool;
pub mod vfs;
pub mod api;
pub mod capability;
pub mod seccomp_guard;
pub mod pii_scrubber;
pub mod backpressure;

// ── Convenience re-exports ────────────────────────────────────────────────────

pub use error::{Result, SandboxError};
pub use sandbox_pool::{ExecutionResult, PoolConfig, SandboxPool};
pub use vfs::VfsState;
pub use resource_monitor::{ResourceMonitor, SandboxResourceLimiter};
pub use api::{AppState, build_router};
pub use capability::{CapabilityValidator, SessionPolicy};
pub use pii_scrubber::PiiScrubber;
pub use backpressure::BackPressureGuard;
