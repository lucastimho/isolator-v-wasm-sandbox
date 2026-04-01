//! # Resource Monitor (RSS Watchdog)
//!
//! Runs as a dedicated `tokio` background task — polling every
//! [`POLL_INTERVAL_MS`] milliseconds — and forcibly evicts any sandbox slot
//! whose **Resident Set Size (RSS)** exceeds the configured hard cap (default
//! 50 MB).
//!
//! ## Design rationale
//!
//! Wasmtime's in-process pooling allocator enforces linear-memory *growth*
//! limits via the `ResourceLimiter` trait callback, but that only catches WASM
//! `memory.grow` calls.  A rogue guest can still accumulate RSS through host
//! objects (large string manipulations, stack depth, allocations made by host
//! shims).  The RSS watchdog is a second, OS-level line of defence.
//!
//! ```text
//!  tokio::spawn(ResourceMonitor::run())
//!       │
//!       │ every POLL_INTERVAL_MS
//!       ▼
//!  for each (SandboxId, SandboxMeta) in registry:
//!       │ sysinfo::System::refresh_process(pid)
//!       │ if rss > limit_mb * 1024 * 1024:
//!       └──► send KillSignal(sandbox_id) → SandboxPool eviction channel
//! ```
//!
//! The pool handles eviction asynchronously so the monitor itself never blocks.

use std::{
    sync::Arc,
    time::Duration,
};

use dashmap::DashMap;
use sysinfo::{Pid, System};
use tokio::{
    sync::mpsc,
    time,
};
use tracing::{debug, info, warn};

// ─── Constants ───────────────────────────────────────────────────────────────

/// How often the watchdog wakes up and re-checks RSS.
const POLL_INTERVAL_MS: u64 = 50;

/// Default RSS cap per sandbox (bytes).  Matches the 50 MB spec.
pub const DEFAULT_RSS_LIMIT_BYTES: u64 = 50 * 1024 * 1024;

// ─── Public types ─────────────────────────────────────────────────────────────

/// A unique, opaque sandbox identifier (mirrors `SandboxId` in sandbox_pool).
/// Defined here as a newtype so resource_monitor has no circular dep on pool.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MonitorId(pub String);

impl std::fmt::Display for MonitorId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Live metadata the monitor needs to evaluate a sandbox.
#[derive(Debug, Clone)]
pub struct SandboxMeta {
    /// OS process ID hosting this sandbox (the worker process / tokio task).
    /// In a single-process model this is always `std::process::id()`.
    pub pid:             u32,
    /// Per-sandbox RSS budget in bytes.
    pub rss_limit_bytes: u64,
    /// Cumulative WASM linear-memory bytes allocated (updated by the pool).
    pub wasm_mem_bytes:  u64,
    /// Readable label for logging (e.g. "python-agent-42").
    pub label:           String,
}

/// A kill command emitted by the watchdog toward the pool's eviction handler.
#[derive(Debug)]
pub struct EvictionOrder {
    pub id:             MonitorId,
    pub reason:         EvictionReason,
    pub observed_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvictionReason {
    RssExceeded,
    WasmMemExceeded,
}

// ─── ResourceLimiter (Wasmtime trait implementation) ─────────────────────────
//
// This is stored *inside* the Wasmtime Store (as part of SandboxData).
// Wasmtime calls `memory_growing()` on every `memory.grow` instruction,
// letting us veto the growth before it happens — the first, in-process layer
// of memory enforcement.

/// Per-sandbox resource limiter stored inside `Store<SandboxData>`.
/// Wasmtime calls these callbacks synchronously on the execution thread.
pub struct SandboxResourceLimiter {
    /// Hard ceiling on WASM linear memory in bytes (50 MB = 800 pages × 64 KB).
    pub memory_limit_bytes: usize,
    /// Hard ceiling on table size (number of elements).
    pub table_limit_elems:  u32,
    /// Running total of currently allocated bytes (updated by Wasmtime).
    pub allocated_bytes:    usize,
}

impl SandboxResourceLimiter {
    pub fn new(memory_limit_bytes: usize) -> Self {
        Self {
            memory_limit_bytes,
            table_limit_elems:  65_536,
            allocated_bytes:    0,
        }
    }
}

impl wasmtime::ResourceLimiter for SandboxResourceLimiter {
    fn memory_growing(
        &mut self,
        current:  usize,
        desired:  usize,
        maximum:  Option<usize>,
    ) -> anyhow::Result<bool> {
        let _ = (current, maximum);
        if desired > self.memory_limit_bytes {
            warn!(
                desired_mb  = desired / (1024 * 1024),
                limit_mb    = self.memory_limit_bytes / (1024 * 1024),
                "ResourceLimiter: memory_growing denied"
            );
            Ok(false) // Wasmtime translates `false` → WASM trap
        } else {
            self.allocated_bytes = desired;
            Ok(true)
        }
    }

    fn table_growing(
        &mut self,
        current:  u32,
        desired:  u32,
        maximum:  Option<u32>,
    ) -> anyhow::Result<bool> {
        let _ = (current, maximum);
        Ok(desired <= self.table_limit_elems)
    }
}

// ─── ResourceMonitor ─────────────────────────────────────────────────────────

/// Spawns a background Tokio task that periodically polls RSS for every
/// registered sandbox and sends `EvictionOrder`s when limits are breached.
pub struct ResourceMonitor {
    /// Shared registry: `SandboxPool` inserts/removes entries here.
    pub registry:      Arc<DashMap<MonitorId, SandboxMeta>>,
    /// Channel the monitor writes eviction orders to.
    eviction_tx:       mpsc::UnboundedSender<EvictionOrder>,
    /// Graceful-shutdown trigger.
    shutdown_tx:       tokio::sync::watch::Sender<bool>,
}

impl ResourceMonitor {
    /// Create a new monitor.
    ///
    /// Returns `(monitor, eviction_rx)` — the pool should `.await` on
    /// `eviction_rx` to process kill orders.
    pub fn new() -> (Self, mpsc::UnboundedReceiver<EvictionOrder>) {
        let (eviction_tx, eviction_rx)  = mpsc::unbounded_channel();
        let (shutdown_tx, _shutdown_rx) = tokio::sync::watch::channel(false);

        let monitor = Self {
            registry:    Arc::new(DashMap::new()),
            eviction_tx,
            shutdown_tx,
        };
        (monitor, eviction_rx)
    }

    /// Register a new sandbox so the watchdog starts tracking it.
    pub fn register(&self, id: MonitorId, meta: SandboxMeta) {
        debug!(sandbox = %id, label = %meta.label, "ResourceMonitor: registered");
        self.registry.insert(id, meta);
    }

    /// Deregister a sandbox (call this after the pool reclaims the slot).
    pub fn deregister(&self, id: &MonitorId) {
        self.registry.remove(id);
        debug!(sandbox = %id, "ResourceMonitor: deregistered");
    }

    /// Spawn the watchdog loop as a detached Tokio task.
    ///
    /// The returned `JoinHandle` can be `.abort()`ed for clean shutdown.
    pub fn spawn(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        let registry    = Arc::clone(&self.registry);
        let eviction_tx = self.eviction_tx.clone();
        let mut shutdown_rx = self.shutdown_tx.subscribe();

        tokio::spawn(async move {
            let mut interval = time::interval(Duration::from_millis(POLL_INTERVAL_MS));
            interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);

            // sysinfo System is kept alive across ticks to amortise init cost.
            let mut sys = System::new();

            info!("ResourceMonitor: watchdog started (poll={}ms)", POLL_INTERVAL_MS);

            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        Self::poll_once(&registry, &eviction_tx, &mut sys);
                    }
                    Ok(_) = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() {
                            info!("ResourceMonitor: graceful shutdown");
                            break;
                        }
                    }
                }
            }
        })
    }

    /// Send the shutdown signal to the watchdog task.
    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }

    // ── Private polling logic ─────────────────────────────────────────────────

    fn poll_once(
        registry:    &DashMap<MonitorId, SandboxMeta>,
        eviction_tx: &mpsc::UnboundedSender<EvictionOrder>,
        sys:         &mut System,
    ) {
        if registry.is_empty() {
            return;
        }

        // Refresh only the pids we care about.
        let pids: Vec<Pid> = registry
            .iter()
            .map(|e| Pid::from_u32(e.value().pid))
            .collect::<std::collections::HashSet<_>>()  // deduplicate
            .into_iter()
            .collect();

        for pid in &pids {
            sys.refresh_process(*pid);
        }

        // Collect violations (avoid holding DashMap ref while sending).
        let mut violations: Vec<EvictionOrder> = Vec::new();

        for entry in registry.iter() {
            let id   = entry.key().clone();
            let meta = entry.value();

            let pid   = Pid::from_u32(meta.pid);
            let rss   = sys
                .process(pid)
                .map(|p| p.memory()) // sysinfo returns KB on Linux, bytes on macOS
                .unwrap_or(0);

            // sysinfo returns bytes on modern versions (0.30+).
            let rss_bytes = rss;

            if rss_bytes > meta.rss_limit_bytes {
                warn!(
                    sandbox    = %id,
                    rss_mb     = rss_bytes as f64 / (1024.0 * 1024.0),
                    limit_mb   = meta.rss_limit_bytes as f64 / (1024.0 * 1024.0),
                    "ResourceMonitor: RSS limit breached — queuing eviction"
                );
                violations.push(EvictionOrder {
                    id,
                    reason:         EvictionReason::RssExceeded,
                    observed_bytes: rss_bytes,
                });
            } else if meta.wasm_mem_bytes > meta.rss_limit_bytes {
                warn!(
                    sandbox      = %id,
                    wasm_mem_mb  = meta.wasm_mem_bytes as f64 / (1024.0 * 1024.0),
                    "ResourceMonitor: WASM linear-memory limit breached — queuing eviction"
                );
                violations.push(EvictionOrder {
                    id,
                    reason:         EvictionReason::WasmMemExceeded,
                    observed_bytes: meta.wasm_mem_bytes,
                });
            }
        }

        for order in violations {
            // Non-blocking send; if the pool's receiver is lagging we just log.
            if eviction_tx.send(order).is_err() {
                warn!("ResourceMonitor: eviction channel closed — pool may be shutting down");
            }
        }
    }
}

// ─── Epoch ticker ─────────────────────────────────────────────────────────────
//
// Wasmtime epoch interruption requires a dedicated task that increments the
// engine's epoch counter on a regular cadence.  We expose this as a free
// function so `SandboxPool::new()` can wire it up.

/// Spawn a task that increments the Wasmtime engine epoch every `interval_ms`.
///
/// The WASM store is configured with `epoch_deadline = quota_ms / interval_ms`,
/// so a guest running continuously will be preempted after `quota_ms`.
///
/// ```text
///   interval_ms = 10ms,  quota_ms = 50ms  →  deadline = 5 ticks
/// ```
pub fn spawn_epoch_ticker(
    engine:      Arc<wasmtime::Engine>,
    interval_ms: u64,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_millis(interval_ms));
        interval.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            engine.increment_epoch();
        }
    })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use wasmtime::ResourceLimiter as _;

    #[test]
    fn resource_limiter_blocks_oversized_growth() {
        let mut limiter = SandboxResourceLimiter::new(50 * 1024 * 1024);
        // Attempt to grow to 49 MB — should be allowed.
        assert!(limiter.memory_growing(0, 49 * 1024 * 1024, None).unwrap());
        // Attempt to grow to 51 MB — should be denied.
        assert!(!limiter.memory_growing(0, 51 * 1024 * 1024, None).unwrap());
    }

    #[test]
    fn resource_limiter_allows_within_limit() {
        let mut limiter = SandboxResourceLimiter::new(50 * 1024 * 1024);
        assert!(limiter.memory_growing(0, 1 * 1024 * 1024, None).unwrap());
        assert!(limiter.memory_growing(0, 25 * 1024 * 1024, None).unwrap());
        assert!(!limiter.memory_growing(0, 51 * 1024 * 1024, None).unwrap());
    }

    #[tokio::test]
    async fn monitor_registers_and_deregisters() {
        let (monitor, _rx) = ResourceMonitor::new();
        let monitor = Arc::new(monitor);

        let id   = MonitorId("test-sandbox-1".into());
        let meta = SandboxMeta {
            pid:             std::process::id(),
            rss_limit_bytes: DEFAULT_RSS_LIMIT_BYTES,
            wasm_mem_bytes:  0,
            label:           "test".into(),
        };

        monitor.register(id.clone(), meta);
        assert!(monitor.registry.contains_key(&id));

        monitor.deregister(&id);
        assert!(!monitor.registry.contains_key(&id));
    }
}
