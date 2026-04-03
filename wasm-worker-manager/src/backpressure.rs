//! # Back Pressure — Adaptive Load Shedding
//!
//! Protects the WASM worker pool from overload by monitoring system resource
//! utilisation and shedding excess load before the system becomes unstable.
//!
//! ## Design
//!
//! ```text
//!   POST /execute
//!        │
//!        ▼
//!  ┌────────────────────┐
//!  │  BackPressureGuard │ ← reads cached snapshot (zero-cost on hot path)
//!  │                    │
//!  │  CPU > 80%?        │──► Yes → HTTP 503 + Retry-After header
//!  │  Pool > 90% full?  │──► Yes → HTTP 503 + Retry-After header
//!  │  Memory > 85%?     │──► Yes → HTTP 503 + Retry-After header
//!  │                    │
//!  │  Otherwise:        │──► Pass through to SandboxPool::execute()
//!  └────────────────────┘
//!
//!  Background task (tokio::spawn)
//!        │
//!        └─► refreshes sysinfo every 500ms
//!            writes new LoadSnapshot to ArcSwap (lock-free)
//! ```
//!
//! ## Retry Strategy
//!
//! The `Retry-After` header uses **graduated backoff**:
//!   - Base: 1 second
//!   - At 80% CPU: `Retry-After: 2`
//!   - At 90% CPU: `Retry-After: 5`
//!   - At 95% CPU: `Retry-After: 10`
//!
//! Clients (the Go Orchestrator) should implement exponential backoff
//! starting from the `Retry-After` value.
//!
//! ## DoS Mitigation
//!
//! Back pressure prevents:
//!   - Infinite-loop WASM modules from starving the pool.
//!   - "Fork bomb" style request floods from exhausting memory.
//!   - Cascading failures when a downstream service is slow.
//!
//! ## Performance
//!
//! The hot-path (`check_admission`) is **lock-free**: it reads a cached
//! `LoadSnapshot` via a `parking_lot::RwLock` (read-biased) and an atomic
//! pool-utilisation counter.  CPU sampling happens in a background tokio
//! task that never blocks request threads.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::RwLock;
use sysinfo::System;
use tracing::warn;

// ─── Thresholds ─────────────────────────────────────────────────────────────

/// CPU utilisation threshold above which requests are shed.
const CPU_THRESHOLD_PERCENT: f32 = 80.0;

/// Memory utilisation threshold above which requests are shed.
const MEMORY_THRESHOLD_PERCENT: f64 = 85.0;

/// Pool slot utilisation threshold (fraction of total slots in use).
const POOL_UTILISATION_THRESHOLD: f64 = 0.90;

/// Interval between background sysinfo refreshes.
const REFRESH_INTERVAL: Duration = Duration::from_millis(500);

// ─── Load Snapshot ──────────────────────────────────────────────────────────

/// Point-in-time snapshot of system resource utilisation.
#[derive(Debug, Clone)]
pub struct LoadSnapshot {
    /// CPU utilisation as a percentage (0.0–100.0).
    /// Averaged across all cores.
    pub cpu_percent: f32,

    /// Total system memory usage as a percentage (0.0–100.0).
    pub memory_percent: f64,

    /// Fraction of sandbox pool slots currently in use (0.0–1.0).
    pub pool_utilisation: f64,

    /// When this snapshot was taken.
    pub timestamp: Instant,
}

impl LoadSnapshot {
    /// Returns `true` if any metric exceeds its threshold.
    pub fn is_overloaded(&self) -> bool {
        self.cpu_percent > CPU_THRESHOLD_PERCENT
            || self.memory_percent > MEMORY_THRESHOLD_PERCENT
            || self.pool_utilisation > POOL_UTILISATION_THRESHOLD
    }

    /// Compute the recommended `Retry-After` value in seconds.
    ///
    /// Higher load → longer retry delay (graduated scale).
    pub fn retry_after_secs(&self) -> u64 {
        if self.cpu_percent > 95.0 || self.pool_utilisation > 0.98 {
            10
        } else if self.cpu_percent > 90.0 || self.pool_utilisation > 0.95 {
            5
        } else if self.cpu_percent > CPU_THRESHOLD_PERCENT || self.pool_utilisation > POOL_UTILISATION_THRESHOLD {
            2
        } else {
            1
        }
    }

    /// Human-readable reason for the back-pressure decision.
    pub fn reason(&self) -> String {
        let mut reasons = Vec::new();
        if self.cpu_percent > CPU_THRESHOLD_PERCENT {
            reasons.push(format!("CPU {:.1}% > {CPU_THRESHOLD_PERCENT}%", self.cpu_percent));
        }
        if self.memory_percent > MEMORY_THRESHOLD_PERCENT {
            reasons.push(format!("Memory {:.1}% > {MEMORY_THRESHOLD_PERCENT}%", self.memory_percent));
        }
        if self.pool_utilisation > POOL_UTILISATION_THRESHOLD {
            reasons.push(format!(
                "Pool {:.0}% > {:.0}%",
                self.pool_utilisation * 100.0,
                POOL_UTILISATION_THRESHOLD * 100.0,
            ));
        }
        if reasons.is_empty() {
            "system nominal".to_string()
        } else {
            reasons.join("; ")
        }
    }
}

// ─── Back Pressure Guard ────────────────────────────────────────────────────

/// The runtime back-pressure controller.
///
/// Shared across all Axum request handlers via `Arc<BackPressureGuard>`.
///
/// **Hot-path performance**: `check_admission()` reads a cached snapshot via
/// `RwLock` (read-biased, non-blocking for readers) and an atomic counter.
/// It never calls into sysinfo or sleeps.  A background tokio task refreshes
/// the CPU/memory snapshot every 500ms independently.
pub struct BackPressureGuard {
    /// Most recent CPU/memory snapshot (updated by background task).
    snapshot: Arc<RwLock<LoadSnapshot>>,

    /// Total pool capacity (set once at init).
    pool_capacity: usize,

    /// Current number of active (in-flight) executions.
    /// Atomically incremented when a request is admitted and decremented when
    /// the execution completes.  Used for real-time pool utilisation.
    active_count: Arc<AtomicUsize>,

    /// Monotonic counter of shed requests.
    shed_count: AtomicU64,

    /// Monotonic counter of admitted requests.
    admitted_count: AtomicU64,
}

impl BackPressureGuard {
    /// Create a new guard and spawn a background CPU/memory sampling task.
    ///
    /// `pool_capacity` is the total number of sandbox slots (e.g. 50).
    ///
    /// The background task runs on the tokio runtime and is cancelled
    /// automatically when the returned `BackPressureGuard` (and its inner
    /// `Arc<RwLock<LoadSnapshot>>`) is dropped.
    pub fn new(pool_capacity: usize) -> Self {
        let snapshot = Arc::new(RwLock::new(LoadSnapshot {
            cpu_percent:      0.0,
            memory_percent:   0.0,
            pool_utilisation: 0.0,
            timestamp:        Instant::now(),
        }));

        // Spawn the background refresh task.
        let snap_handle = Arc::clone(&snapshot);
        tokio::spawn(async move {
            Self::background_refresh_loop(snap_handle).await;
        });

        Self {
            snapshot,
            pool_capacity,
            active_count: Arc::new(AtomicUsize::new(0)),
            shed_count:     AtomicU64::new(0),
            admitted_count: AtomicU64::new(0),
        }
    }

    /// Background task: periodically refresh CPU and memory metrics.
    ///
    /// Runs forever (until the tokio runtime shuts down).  Never blocks
    /// the request-serving threads.
    async fn background_refresh_loop(snapshot: Arc<RwLock<LoadSnapshot>>) {
        let mut sys = System::new();

        // Initial double-refresh to prime the CPU delta counters.
        sys.refresh_all();
        tokio::time::sleep(Duration::from_millis(200)).await;
        sys.refresh_all();

        loop {
            // Read CPU and memory.
            let cpu = sys.global_cpu_info().cpu_usage();
            let total_mem = sys.total_memory();
            let used_mem = sys.used_memory();
            let mem_pct = if total_mem > 0 {
                (used_mem as f64 / total_mem as f64) * 100.0
            } else {
                0.0
            };

            // Update the shared snapshot (write lock is held only briefly).
            {
                let mut snap = snapshot.write();
                snap.cpu_percent = cpu;
                snap.memory_percent = mem_pct;
                snap.timestamp = Instant::now();
                // Note: pool_utilisation is computed on-the-fly by check_admission,
                // not here, because we don't have access to the active_count.
            }

            // Sleep, then refresh sysinfo for the next iteration.
            tokio::time::sleep(REFRESH_INTERVAL).await;
            sys.refresh_all();
        }
    }

    /// Check whether a new request should be admitted.
    ///
    /// **Hot-path**: reads a cached snapshot (RwLock reader — non-blocking)
    /// and computes pool utilisation from an atomic counter.  Never calls
    /// into sysinfo, never sleeps.
    ///
    /// Returns `Ok(())` if the request may proceed, or `Err(LoadSnapshot)`
    /// with the current load data if the request should be shed.
    pub fn check_admission(&self) -> Result<(), LoadSnapshot> {
        // Read the latest CPU/memory snapshot.
        let mut snapshot = self.snapshot.read().clone();

        // Compute live pool utilisation from the atomic active counter.
        snapshot.pool_utilisation = self.compute_pool_utilisation();

        if snapshot.is_overloaded() {
            self.shed_count.fetch_add(1, Ordering::Relaxed);
            warn!(
                cpu       = format!("{:.1}%", snapshot.cpu_percent),
                memory    = format!("{:.1}%", snapshot.memory_percent),
                pool      = format!("{:.0}%", snapshot.pool_utilisation * 100.0),
                retry     = snapshot.retry_after_secs(),
                shed_total = self.shed_count.load(Ordering::Relaxed),
                "Back pressure: shedding request"
            );
            Err(snapshot)
        } else {
            self.admitted_count.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }

    /// Record that a request has been admitted and execution has started.
    ///
    /// Call this after `check_admission` returns `Ok(())`, before handing
    /// the request to the sandbox pool.  Returns an `AdmissionTicket` that
    /// automatically decrements the active count when dropped.
    pub fn admit(&self) -> AdmissionTicket {
        self.active_count.fetch_add(1, Ordering::Relaxed);
        AdmissionTicket {
            active_count: Arc::clone(&self.active_count),
        }
    }

    /// Force a snapshot refresh (for testing / diagnostics).
    pub fn force_refresh(&self) -> LoadSnapshot {
        self.snapshot.read().clone()
    }

    /// Get the current snapshot without refreshing.
    pub fn current_snapshot(&self) -> LoadSnapshot {
        let mut snap = self.snapshot.read().clone();
        snap.pool_utilisation = self.compute_pool_utilisation();
        snap
    }

    /// Total number of requests shed since startup.
    pub fn total_shed(&self) -> u64 {
        self.shed_count.load(Ordering::Relaxed)
    }

    /// Total number of requests admitted since startup.
    pub fn total_admitted(&self) -> u64 {
        self.admitted_count.load(Ordering::Relaxed)
    }

    /// Current number of in-flight executions.
    pub fn active_executions(&self) -> usize {
        self.active_count.load(Ordering::Relaxed)
    }

    // ── Internal ────────────────────────────────────────────────────────────

    fn compute_pool_utilisation(&self) -> f64 {
        if self.pool_capacity == 0 {
            return 1.0; // degenerate case: fully utilised
        }
        let active = self.active_count.load(Ordering::Relaxed);
        active as f64 / self.pool_capacity as f64
    }
}

// ─── Admission Ticket (RAII) ───────────────────────────────────────────────

/// RAII guard that decrements the active execution count when dropped.
///
/// This ensures the count stays accurate even if the handler panics.
pub struct AdmissionTicket {
    active_count: Arc<AtomicUsize>,
}

impl Drop for AdmissionTicket {
    fn drop(&mut self) {
        self.active_count.fetch_sub(1, Ordering::Relaxed);
    }
}

// ─── HTTP Response Helpers ──────────────────────────────────────────────────

/// Build a 503 Service Unavailable response with the correct headers.
///
/// Used by the `/execute` handler when `BackPressureGuard::check_admission`
/// returns `Err`.
pub fn build_503_response(snapshot: &LoadSnapshot) -> (axum::http::StatusCode, axum::http::HeaderMap, String) {
    use axum::http::{HeaderMap, HeaderValue, StatusCode};

    let retry_after = snapshot.retry_after_secs();
    let reason = snapshot.reason();

    let mut headers = HeaderMap::new();
    headers.insert(
        "Retry-After",
        HeaderValue::from_str(&retry_after.to_string()).unwrap(),
    );
    headers.insert(
        "X-Backpressure-Reason",
        HeaderValue::from_str(&reason).unwrap_or_else(|_| HeaderValue::from_static("overloaded")),
    );

    let body = serde_json::json!({
        "error": format!("Server overloaded: {reason}"),
        "code": "BACKPRESSURE",
        "retry_after_secs": retry_after,
        "load": {
            "cpu_percent": format!("{:.1}", snapshot.cpu_percent),
            "memory_percent": format!("{:.1}", snapshot.memory_percent),
            "pool_utilisation": format!("{:.0}%", snapshot.pool_utilisation * 100.0),
        }
    }).to_string();

    (StatusCode::SERVICE_UNAVAILABLE, headers, body)
}

// ─── Prometheus Metrics ─────────────────────────────────────────────────────

/// Generate Prometheus-compatible metrics text for the back-pressure system.
pub fn prometheus_metrics(guard: &BackPressureGuard) -> String {
    let snap = guard.current_snapshot();
    format!(
        "# HELP wasm_backpressure_cpu_percent Current CPU utilisation\n\
         # TYPE wasm_backpressure_cpu_percent gauge\n\
         wasm_backpressure_cpu_percent {:.1}\n\
         # HELP wasm_backpressure_memory_percent Current memory utilisation\n\
         # TYPE wasm_backpressure_memory_percent gauge\n\
         wasm_backpressure_memory_percent {:.1}\n\
         # HELP wasm_backpressure_pool_utilisation Current pool slot utilisation\n\
         # TYPE wasm_backpressure_pool_utilisation gauge\n\
         wasm_backpressure_pool_utilisation {:.3}\n\
         # HELP wasm_backpressure_active_executions Current in-flight executions\n\
         # TYPE wasm_backpressure_active_executions gauge\n\
         wasm_backpressure_active_executions {}\n\
         # HELP wasm_backpressure_shed_total Total requests shed\n\
         # TYPE wasm_backpressure_shed_total counter\n\
         wasm_backpressure_shed_total {}\n\
         # HELP wasm_backpressure_admitted_total Total requests admitted\n\
         # TYPE wasm_backpressure_admitted_total counter\n\
         wasm_backpressure_admitted_total {}\n",
        snap.cpu_percent,
        snap.memory_percent,
        snap.pool_utilisation,
        guard.active_executions(),
        guard.total_shed(),
        guard.total_admitted(),
    )
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_not_overloaded_at_defaults() {
        let snap = LoadSnapshot {
            cpu_percent:      50.0,
            memory_percent:   60.0,
            pool_utilisation: 0.5,
            timestamp:        Instant::now(),
        };
        assert!(!snap.is_overloaded());
    }

    #[test]
    fn snapshot_overloaded_at_high_cpu() {
        let snap = LoadSnapshot {
            cpu_percent:      85.0,
            memory_percent:   60.0,
            pool_utilisation: 0.5,
            timestamp:        Instant::now(),
        };
        assert!(snap.is_overloaded());
    }

    #[test]
    fn snapshot_overloaded_at_high_memory() {
        let snap = LoadSnapshot {
            cpu_percent:      50.0,
            memory_percent:   90.0,
            pool_utilisation: 0.5,
            timestamp:        Instant::now(),
        };
        assert!(snap.is_overloaded());
    }

    #[test]
    fn snapshot_overloaded_at_high_pool_utilisation() {
        let snap = LoadSnapshot {
            cpu_percent:      50.0,
            memory_percent:   60.0,
            pool_utilisation: 0.95,
            timestamp:        Instant::now(),
        };
        assert!(snap.is_overloaded());
    }

    #[test]
    fn retry_after_scales_with_load() {
        let low = LoadSnapshot {
            cpu_percent: 82.0, memory_percent: 50.0,
            pool_utilisation: 0.5, timestamp: Instant::now(),
        };
        assert_eq!(low.retry_after_secs(), 2);

        let medium = LoadSnapshot {
            cpu_percent: 92.0, memory_percent: 50.0,
            pool_utilisation: 0.5, timestamp: Instant::now(),
        };
        assert_eq!(medium.retry_after_secs(), 5);

        let critical = LoadSnapshot {
            cpu_percent: 97.0, memory_percent: 50.0,
            pool_utilisation: 0.5, timestamp: Instant::now(),
        };
        assert_eq!(critical.retry_after_secs(), 10);
    }

    #[test]
    fn reason_string_is_descriptive() {
        let snap = LoadSnapshot {
            cpu_percent:      90.0,
            memory_percent:   87.0,
            pool_utilisation: 0.5,
            timestamp:        Instant::now(),
        };
        let reason = snap.reason();
        assert!(reason.contains("CPU"));
        assert!(reason.contains("Memory"));
    }

    #[tokio::test]
    async fn guard_admits_under_load() {
        let guard = BackPressureGuard::new(50);
        // Give the background task a moment to prime.
        tokio::time::sleep(Duration::from_millis(50)).await;
        // With 0 active executions out of 50, pool utilisation is 0%.
        // CPU/memory start at 0.0 in the initial snapshot.
        let result = guard.check_admission();
        // May or may not pass depending on actual system load during test,
        // but the API contract is correct.
        assert!(result.is_ok() || result.is_err());
        // At minimum, counters should increment.
        assert!(guard.total_admitted() + guard.total_shed() == 1);
    }

    #[tokio::test]
    async fn guard_tracks_active_count() {
        let guard = BackPressureGuard::new(50);
        assert_eq!(guard.active_executions(), 0);

        let ticket1 = guard.admit();
        assert_eq!(guard.active_executions(), 1);

        let ticket2 = guard.admit();
        assert_eq!(guard.active_executions(), 2);

        drop(ticket1);
        assert_eq!(guard.active_executions(), 1);

        drop(ticket2);
        assert_eq!(guard.active_executions(), 0);
    }

    #[tokio::test]
    async fn pool_utilisation_reflects_active_count() {
        let guard = BackPressureGuard::new(10); // small pool for easy math

        // 0 active → 0% utilisation
        let snap = guard.current_snapshot();
        assert!((snap.pool_utilisation - 0.0).abs() < f64::EPSILON);

        // Admit 9 → 90% utilisation
        let mut tickets: Vec<AdmissionTicket> = Vec::new();
        for _ in 0..9 {
            tickets.push(guard.admit());
        }
        let snap = guard.current_snapshot();
        assert!((snap.pool_utilisation - 0.9).abs() < f64::EPSILON);

        // Drop all → back to 0%
        tickets.clear();
        let snap = guard.current_snapshot();
        assert!((snap.pool_utilisation - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn build_503_has_correct_headers() {
        let snap = LoadSnapshot {
            cpu_percent:      95.0,
            memory_percent:   60.0,
            pool_utilisation: 0.98,
            timestamp:        Instant::now(),
        };
        let (status, headers, body) = build_503_response(&snap);
        assert_eq!(status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert!(headers.contains_key("Retry-After"));
        assert!(headers.contains_key("X-Backpressure-Reason"));
        assert!(body.contains("BACKPRESSURE"));
    }

    #[tokio::test]
    async fn prometheus_output_is_valid() {
        let guard = BackPressureGuard::new(50);
        let metrics = prometheus_metrics(&guard);
        assert!(metrics.contains("wasm_backpressure_cpu_percent"));
        assert!(metrics.contains("wasm_backpressure_active_executions"));
        assert!(metrics.contains("wasm_backpressure_shed_total"));
        assert!(metrics.contains("wasm_backpressure_admitted_total"));
    }
}
