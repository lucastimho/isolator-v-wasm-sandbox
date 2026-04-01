//! # WASM Worker Manager — Entry Point
//!
//! ## Startup sequence
//!
//! ```text
//! main()
//!   ├─ init tracing (JSON structured logging)
//!   ├─ SandboxPool::new(PoolConfig)
//!   │     ├─ build_engine()         // Wasmtime + pooling allocator + epoch
//!   │     ├─ prewarm(50 slots)      // sub-20ms cold start baseline
//!   │     └─ spawn background tasks:
//!   │           ├─ epoch_ticker     // 10ms CPU preemption clock
//!   │           ├─ ResourceMonitor  // RSS watchdog (50ms poll)
//!   │           └─ eviction_loop    // processes kill orders
//!   │
//!   └─ axum HTTP server → 0.0.0.0:3000
//!         ├─ POST /execute          // submit WASM; get JSON result
//!         ├─ GET  /stream/:job_id   // SSE real-time stdout bridge
//!         ├─ GET  /health           // liveness / warm-slot count
//!         └─ GET  /metrics          // Prometheus text metrics
//! ```
//!
//! ## Execute lifecycle
//!
//! ```text
//!   POST /execute
//!     │  base64-decode wasm_bytes
//!     │  pool.execute(wasm_bytes, label)
//!     │    ├─ acquire warm slot   // O(1) from VecDeque
//!     │    ├─ inject code → VFS   // /workspace/main.wasm
//!     │    ├─ link WASI shims     // VFS interceptor (zero host access)
//!     │    ├─ run _start          // epoch-preempted at quota
//!     │    └─ return stdout/stderr/vfs_snapshot
//!     └─ JSON response
//! ```

#![warn(clippy::all, clippy::pedantic)]
#![allow(clippy::module_name_repetitions)]

mod api;
mod error;
mod resource_monitor;
mod sandbox_pool;
mod vfs;

use std::{sync::Arc, time::Duration};

use tracing::{error, info};
use tracing_subscriber::EnvFilter;

use wasmtime::ResourceLimiter as _;

use api::AppState;
use sandbox_pool::{PoolConfig, SandboxPool};

// ─── Main ─────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // ── Initialise structured logging ────────────────────────────────────────
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(true)
        .with_thread_ids(true)
        .json()
        .init();

    info!(
        version        = env!("CARGO_PKG_VERSION"),
        pool_size      = 50,
        memory_limit   = "50MB",
        cpu_quota_ms   = 50,
        epoch_tick_ms  = 10,
        "WASM Worker Manager starting"
    );

    // ── Build the pre-warmed pool ─────────────────────────────────────────────
    // All tunables are expressed in PoolConfig — no environment variables are
    // exposed to guest code (Least Privilege principle).
    let config = PoolConfig {
        pool_size:          50,
        rss_limit_bytes:    50 * 1024 * 1024, // 50 MB RSS hard cap
        memory_limit_bytes: 50 * 1024 * 1024, // 50 MB WASM linear-memory cap
        epoch_tick_ms:      10,               // Epoch fires every 10ms
        cpu_quota_ticks:    5,                // 5 ticks × 10ms = 50ms CPU budget
    };

    let pool = SandboxPool::new(config, None).await?;

    info!(warm_slots = pool.warm_count(), "Pool initialised — starting HTTP server");

    // ── Self-test: VFS round-trip ─────────────────────────────────────────────
    demo_vfs_usage();

    // ── Self-test: ResourceLimiter ────────────────────────────────────────────
    demo_resource_monitor_stats(&pool);

    // ── Axum HTTP server ─────────────────────────────────────────────────────
    let state   = AppState::new(Arc::clone(&pool));
    let listen  = std::env::var("LISTEN_ADDR").unwrap_or_else(|_| "0.0.0.0:3000".into());

    // Run until Ctrl-C (graceful shutdown wired inside `api::serve`).
    if let Err(e) = api::serve(state, &listen).await {
        error!(error = %e, "HTTP server exited with error");
    }

    // ── Graceful shutdown ─────────────────────────────────────────────────────
    info!("Sending pool shutdown signal...");
    pool.shutdown();
    tokio::time::sleep(Duration::from_millis(200)).await;

    info!("WASM Worker Manager stopped cleanly.");
    Ok(())
}

// ─── Demo: concurrent execution ───────────────────────────────────────────────

async fn demo_concurrent_execution(pool: Arc<SandboxPool>) {
    const CONCURRENCY: usize = 10;

    info!(n = CONCURRENCY, "Launching {} concurrent sandboxes...", CONCURRENCY);

    let start   = std::time::Instant::now();
    let handles: Vec<_> = (0..CONCURRENCY)
        .map(|i| {
            let pool_ref = Arc::clone(&pool);
            // The noop stub WASM bytes (exported _start, does nothing).
            let wasm = noop_wasm_bytes();
            tokio::spawn(async move {
                let label  = format!("agent-{i}");
                let result = pool_ref.execute(wasm, &label).await;
                (i, result)
            })
        })
        .collect();

    let mut successes = 0usize;
    let mut failures  = 0usize;

    for handle in handles {
        match handle.await {
            Ok((i, Ok(result))) => {
                successes += 1;
                info!(
                    i,
                    sandbox_id = %result.sandbox_id,
                    elapsed_us = result.elapsed.as_micros(),
                    exit_code  = result.exit_code,
                    "sandbox completed"
                );
            }
            Ok((i, Err(e))) => {
                failures += 1;
                error!(i, error = %e, "sandbox error");
            }
            Err(join_err) => {
                failures += 1;
                error!(error = %join_err, "task join error");
            }
        }
    }

    let total_ms = start.elapsed().as_millis();
    info!(
        successes,
        failures,
        total_ms,
        warm_slots_remaining = pool.warm_count(),
        "Concurrent execution demo complete"
    );
}

// ─── Demo: VFS usage ──────────────────────────────────────────────────────────

fn demo_vfs_usage() {
    use vfs::{FdFlags, OpenFlags, Rights, VfsState};

    info!("--- VFS Demo ---");

    let vfs = VfsState::new();
    let rights = Rights(Rights::FD_READ | Rights::FD_WRITE | Rights::FD_SEEK);

    // Create a file and write to it.
    let fd = vfs
        .path_open("/workspace/data.json", OpenFlags(OpenFlags::CREAT), rights, FdFlags(0))
        .expect("open failed");

    let payload = br#"{"model":"claude-sonnet-4-6","status":"running"}"#;
    let n = vfs.fd_write(fd, payload).expect("write failed");
    info!(bytes_written = n, path = "/workspace/data.json", "VFS write OK");

    // Seek back and read.
    vfs.fd_seek(fd, 0, 0).expect("seek failed");
    let mut buf = vec![0u8; payload.len()];
    let n = vfs.fd_read(fd, &mut buf).expect("read failed");
    assert_eq!(&buf[..n], payload, "VFS round-trip mismatch!");
    info!(bytes_read = n, content = std::str::from_utf8(&buf[..n]).unwrap_or("?"), "VFS read OK");

    vfs.fd_close(fd).unwrap();

    // List the directory.
    let entries = vfs.list_dir("/workspace").expect("listdir failed");
    info!(entries = ?entries, "VFS /workspace contents");

    // Demonstrate path traversal rejection.
    let result = VfsState::canonicalise("/../etc/passwd");
    assert!(result.is_err(), "traversal should be rejected");
    info!("Path traversal '/../etc/passwd' correctly rejected");

    // Ring buffer (stdout capture) demo.
    vfs.stdout.write(b"Hello from WASM stdout!\n");
    vfs.stdout.write(b"Line 2\n");
    let drained = vfs.stdout.drain();
    info!(
        bytes = drained.len(),
        content = std::str::from_utf8(&drained).unwrap_or("?"),
        "Stdout ring buffer drained"
    );

    info!("--- VFS Demo complete ---");
}

// ─── Demo: ResourceMonitor stats ─────────────────────────────────────────────

fn demo_resource_monitor_stats(pool: &SandboxPool) {
    use resource_monitor::SandboxResourceLimiter;

    info!("--- ResourceMonitor Demo ---");
    info!(warm_slots = pool.warm_count(), "Current warm slot count");

    // Show the ResourceLimiter logic inline.
    let mut limiter = SandboxResourceLimiter::new(50 * 1024 * 1024);

    // 40 MB growth → allowed.
    let allowed = limiter.memory_growing(0, 40 * 1024 * 1024, None).unwrap();
    info!(allowed, desired_mb = 40, "ResourceLimiter: 40MB growth");

    // 55 MB growth → denied.
    let allowed = limiter.memory_growing(0, 55 * 1024 * 1024, None).unwrap();
    info!(allowed, desired_mb = 55, "ResourceLimiter: 55MB growth (should be denied)");

    info!("--- ResourceMonitor Demo complete ---");
}

// ─── No-op WASM bytes ─────────────────────────────────────────────────────────

/// Minimal valid WASM binary: `(module (func (export "_start")))`.
/// Used in the demo in lieu of a real agent payload.
fn noop_wasm_bytes() -> Vec<u8> {
    vec![
        0x00, 0x61, 0x73, 0x6d, // magic
        0x01, 0x00, 0x00, 0x00, // version
        0x01, 0x04, 0x01, 0x60, 0x00, 0x00,              // type section
        0x03, 0x02, 0x01, 0x00,                           // function section
        0x07, 0x09, 0x01, 0x06, 0x5f, 0x73, 0x74, 0x61,  // export section: "_start"
        0x72, 0x74, 0x00, 0x00,
        0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,              // code section: empty body
    ]
}
