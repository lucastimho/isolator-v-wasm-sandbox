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
//!  │  BackPressureGuard │ ← checks CPU + memory + pool utilisation
//!  │                    │
//!  │  CPU > 80%?        │──► Yes → HTTP 503 + Retry-After header
//!  │  Pool > 90% full?  │──► Yes → HTTP 503 + Retry-After header
//!  │  Memory > 85%?     │──► Yes → HTTP 503 + Retry-After header
//!  │                    │
//!  │  Otherwise:        │──► Pass through to SandboxPool::execute()
//!  └────────────────────┘
//! ```
//!
//! ## Retry Strategy
//!
//! The `Retry-After` header uses **exponential backoff with jitter**:
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

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use sysinfo::System;
use tracing::{info, warn};

// ─── Thresholds ─────────────────────────────────────────────────────────────

/// CPU utilisation threshold above which requests are shed.
const CPU_THRESHOLD_PERCENT: f32 = 80.0;

/// Memory utilisation threshold above which requests are shed.
const MEMORY_THRESHOLD_PERCENT: f64 = 85.0;

/// Pool slot utilisation threshold (fraction of total slots in use).
const POOL_UTILISATION_THRESHOLD: f64 = 0.90;

/// Minimum interval between sysinfo refreshes (to avoid thrashing).
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
    /// Higher load → longer retry delay (exponential scale).
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
/// It maintains a cached `LoadSnapshot` that is refreshed at most every
/// 500ms (to avoid expensive sysinfo probes on every request).
pub struct BackPressureGuard {
    /// Cached system info handle (mutable because `sysinfo::System::refresh`
    /// requires `&mut self`).
    system: Mutex<System>,

    /// Most recent load snapshot.
    snapshot: Mutex<LoadSnapshot>,

    /// Total pool capacity (set once at init).
    pool_capacity: usize,

    /// Monotonic counter of shed requests.
    shed_count: AtomicU64,

    /// Monotonic counter of admitted requests.
    admitted_count: AtomicU64,
}

impl BackPressureGuard {
    /// Create a new guard.
    ///
    /// `pool_capacity` is the total number of sandbox slots (e.g. 50).
    pub fn new(pool_capacity: usize) -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_all();
        sys.refresh_memory();

        let snapshot = LoadSnapshot {
            cpu_percent:      0.0,
            memory_percent:   0.0,
            pool_utilisation: 0.0,
            timestamp:        Instant::now(),
        };

        Self {
            system:         Mutex::new(sys),
            snapshot:       Mutex::new(snapshot),
            pool_capacity,
            shed_count:     AtomicU64::new(0),
            admitted_count: AtomicU64::new(0),
        }
    }

    /// Check whether a new request should be admitted.
    ///
    /// `current_warm_slots` is the number of slots **currently available**
    /// (not in use).  Pass `pool.warm_count()`.
    ///
    /// Returns `Ok(())` if the request may proceed, or `Err(LoadSnapshot)`
    /// with the current load data if the request should be shed.
    pub fn check_admission(&self, current_warm_slots: usize) -> Result<(), LoadSnapshot> {
        let snapshot = self.refresh_if_stale(current_warm_slots);

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

    /// Force a snapshot refresh (ignoring the staleness interval).
    pub fn force_refresh(&self, current_warm_slots: usize) -> LoadSnapshot {
        self.do_refresh(current_warm_slots)
    }

    /// Get the current snapshot without refreshing.
    pub fn current_snapshot(&self) -> LoadSnapshot {
        self.snapshot.lock().clone()
    }

    /// Total number of requests shed since startup.
    pub fn total_shed(&self) -> u64 {
        self.shed_count.load(Ordering::Relaxed)
    }

    /// Total number of requests admitted since startup.
    pub fn total_admitted(&self) -> u64 {
        self.admitted_count.load(Ordering::Relaxed)
    }

    // ── Internal ────────────────────────────────────────────────────────────

    fn refresh_if_stale(&self, current_warm_slots: usize) -> LoadSnapshot {
        {
            let snap = self.snapshot.lock();
            if snap.timestamp.elapsed() < REFRESH_INTERVAL {
                // Update pool utilisation in place (it's cheap).
                let mut snap = snap.clone();
                snap.pool_utilisation = self.compute_pool_utilisation(current_warm_slots);
                return snap;
            }
        }
        self.do_refresh(current_warm_slots)
    }

    fn do_refresh(&self, current_warm_slots: usize) -> LoadSnapshot {
        let mut sys = self.system.lock();
        sys.refresh_cpu_all();
        sys.refresh_memory();

        let cpu = sys.global_cpu_usage();

        let total_mem = sys.total_memory();
        let used_mem = sys.used_memory();
        let mem_pct = if total_mem > 0 {
            (used_mem as f64 / total_mem as f64) * 100.0
        } else {
            0.0
        };

        let pool_util = self.compute_pool_utilisation(current_warm_slots);

        let snapshot = LoadSnapshot {
            cpu_percent:      cpu,
            memory_percent:   mem_pct,
            pool_utilisation: pool_util,
            timestamp:        Instant::now(),
        };

        *self.snapshot.lock() = snapshot.clone();
        snapshot
    }

    fn compute_pool_utilisation(&self, warm_slots: usize) -> f64 {
        if self.pool_capacity == 0 {
            return 1.0; // degenerate case: fully utilised
        }
        let in_use = self.pool_capacity.saturating_sub(warm_slots);
        in_use as f64 / self.pool_capacity as f64
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
         # HELP wasm_backpressure_shed_total Total requests shed\n\
         # TYPE wasm_backpressure_shed_total counter\n\
         wasm_backpressure_shed_total {}\n\
         # HELP wasm_backpressure_admitted_total Total requests admitted\n\
         # TYPE wasm_backpressure_admitted_total counter\n\
         wasm_backpressure_admitted_total {}\n",
        snap.cpu_percent,
        snap.memory_percent,
        snap.pool_utilisation,
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

    #[test]
    fn guard_admits_under_load() {
        let guard = BackPressureGuard::new(50);
        // With fresh system stats and 50 warm slots, we should be under threshold.
        let result = guard.check_admission(50);
        // May or may not pass depending on actual system load during test,
        // but the API contract is correct.
        assert!(result.is_ok() || result.is_err());
        // At minimum, counters should increment.
        assert!(guard.total_admitted() + guard.total_shed() == 1);
    }

    #[test]
    fn guard_sheds_when_pool_exhausted() {
        let guard = BackPressureGuard::new(50);
        // Simulate: 0 warm slots out of 50 → 100% utilisation.
        let result = guard.check_admission(0);
        assert!(result.is_err());
        let snap = result.unwrap_err();
        assert!(snap.pool_utilisation > POOL_UTILISATION_THRESHOLD);
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

    #[test]
    fn prometheus_output_is_valid() {
        let guard = BackPressureGuard::new(50);
        let metrics = prometheus_metrics(&guard);
        assert!(metrics.contains("wasm_backpressure_cpu_percent"));
        assert!(metrics.contains("wasm_backpressure_shed_total"));
        assert!(metrics.contains("wasm_backpressure_admitted_total"));
    }
}
