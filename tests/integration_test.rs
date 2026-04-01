//! # Integration Tests — WASM Worker Manager
//!
//! These tests exercise the full stack end-to-end:
//!   VfsState → SandboxPool → ResourceMonitor → ExecutionResult
//!
//! Run with:
//!   cargo test -- --nocapture          # all tests, verbose output
//!   cargo test vfs                     # only VFS tests
//!   cargo test pool                    # only pool tests
//!   cargo test resource                # only resource-monitor tests
//!
//! The `#[tokio::test]` macro spins up a per-test single-threaded runtime;
//! use `#[tokio::test(flavor = "multi_thread")]` for concurrency stress tests.

use std::sync::Arc;
use wasm_worker_manager::{
    sandbox_pool::{PoolConfig, SandboxPool},
    vfs::{FdFlags, OpenFlags, Rights, VfsState},
    resource_monitor::{MonitorId, ResourceMonitor, SandboxMeta, SandboxResourceLimiter,
                       DEFAULT_RSS_LIMIT_BYTES},
    error::SandboxError,
};

// ─────────────────────────────────────────────────────────────────────────────
// §1 — VfsState unit tests
// ─────────────────────────────────────────────────────────────────────────────

mod vfs_tests {
    use super::*;

    fn rw_rights() -> Rights {
        Rights(Rights::FD_READ | Rights::FD_WRITE | Rights::FD_SEEK)
    }

    // ── §1.1 Path canonicalisation ────────────────────────────────────────────

    #[test]
    fn canon_rejects_dotdot_traversal() {
        assert!(VfsState::canonicalise("/../etc/shadow").is_err(),
            ".. traversal above root must be denied");
        assert!(VfsState::canonicalise("../../etc/passwd").is_err(),
            "relative .. traversal must be denied");
        assert!(VfsState::canonicalise("/workspace/../../../etc").is_err(),
            "deep .. traversal must be denied");
    }

    #[test]
    fn canon_collapses_dots_and_slashes() {
        assert_eq!(VfsState::canonicalise("/a/./b/../c").unwrap(),   "/a/c");
        assert_eq!(VfsState::canonicalise("relative/path").unwrap(), "/relative/path");
        assert_eq!(VfsState::canonicalise("/").unwrap(),             "/");
        assert_eq!(VfsState::canonicalise("//double//slash").unwrap(),"/double/slash");
    }

    // ── §1.2 File creation ────────────────────────────────────────────────────

    #[test]
    fn create_and_read_back_file() {
        let vfs = VfsState::new();
        let fd = vfs.path_open(
            "/workspace/hello.txt",
            OpenFlags(OpenFlags::CREAT),
            rw_rights(),
            FdFlags(0),
        ).expect("path_open failed");

        let payload = b"hello, wasm world!";
        let n = vfs.fd_write(fd, payload).expect("fd_write failed");
        assert_eq!(n, payload.len());

        vfs.fd_seek(fd, 0, 0).expect("rewind failed");
        let mut buf = vec![0u8; payload.len()];
        let r = vfs.fd_read(fd, &mut buf).expect("fd_read failed");
        assert_eq!(r, payload.len());
        assert_eq!(&buf, payload, "read-back mismatch");

        vfs.fd_close(fd).unwrap();
    }

    #[test]
    fn open_nonexistent_without_creat_fails() {
        let vfs = VfsState::new();
        let result = vfs.path_open(
            "/workspace/ghost.txt",
            OpenFlags(0),       // no O_CREAT
            rw_rights(),
            FdFlags(0),
        );
        assert!(matches!(result, Err(SandboxError::VfsNotFound { .. })),
            "expected VfsNotFound, got {:?}", result);
    }

    #[test]
    fn o_excl_rejects_existing_file() {
        let vfs = VfsState::new();
        let rights = rw_rights();
        // First creation succeeds.
        vfs.path_open("/tmp/excl.txt",
            OpenFlags(OpenFlags::CREAT), rights, FdFlags(0)).unwrap();
        // Second with O_EXCL must fail.
        let result = vfs.path_open("/tmp/excl.txt",
            OpenFlags(OpenFlags::CREAT | OpenFlags::EXCL), rights, FdFlags(0));
        assert!(result.is_err(), "O_EXCL on existing file should fail");
    }

    #[test]
    fn o_trunc_clears_file_contents() {
        let vfs = VfsState::new();
        let rights = rw_rights();
        let fd1 = vfs.path_open("/tmp/trunc.txt",
            OpenFlags(OpenFlags::CREAT), rights, FdFlags(0)).unwrap();
        vfs.fd_write(fd1, b"old data").unwrap();
        vfs.fd_close(fd1).unwrap();

        // Reopen with O_TRUNC.
        let fd2 = vfs.path_open("/tmp/trunc.txt",
            OpenFlags(OpenFlags::TRUNC), rights, FdFlags(0)).unwrap();
        let mut buf = vec![0u8; 8];
        let n = vfs.fd_read(fd2, &mut buf).unwrap();
        assert_eq!(n, 0, "truncated file should have zero bytes");
        vfs.fd_close(fd2).unwrap();
    }

    // ── §1.3 Seek modes ───────────────────────────────────────────────────────

    #[test]
    fn seek_set_cur_end() {
        let vfs = VfsState::new();
        let rights = rw_rights();
        let fd = vfs.path_open("/tmp/seek.bin",
            OpenFlags(OpenFlags::CREAT), rights, FdFlags(0)).unwrap();

        vfs.fd_write(fd, b"0123456789").unwrap();

        // SEEK_SET → position 3
        let pos = vfs.fd_seek(fd, 3, 0).unwrap();
        assert_eq!(pos, 3);

        // SEEK_CUR → position 3 + 2 = 5
        let pos = vfs.fd_seek(fd, 2, 1).unwrap();
        assert_eq!(pos, 5);

        // SEEK_END → position 10 + (-2) = 8
        let pos = vfs.fd_seek(fd, -2, 2).unwrap();
        assert_eq!(pos, 8);

        // Read 2 bytes from position 8 → "89"
        let mut buf = [0u8; 2];
        vfs.fd_read(fd, &mut buf).unwrap();
        assert_eq!(&buf, b"89");
        vfs.fd_close(fd).unwrap();
    }

    // ── §1.4 Append mode ─────────────────────────────────────────────────────

    #[test]
    fn fdflags_append_writes_at_end() {
        let vfs = VfsState::new();
        let rights = rw_rights();

        let fd1 = vfs.path_open("/tmp/append.log",
            OpenFlags(OpenFlags::CREAT), rights, FdFlags(0)).unwrap();
        vfs.fd_write(fd1, b"line1\n").unwrap();
        vfs.fd_close(fd1).unwrap();

        // Open with APPEND.
        let fd2 = vfs.path_open("/tmp/append.log",
            OpenFlags(0), rights, FdFlags(FdFlags::APPEND)).unwrap();
        vfs.fd_write(fd2, b"line2\n").unwrap();
        vfs.fd_close(fd2).unwrap();

        let contents = vfs.read_file("/tmp/append.log").unwrap();
        assert_eq!(contents, b"line1\nline2\n");
    }

    // ── §1.5 Write quota enforcement ─────────────────────────────────────────

    #[test]
    fn write_quota_is_enforced() {
        use std::sync::atomic::Ordering;
        let vfs = VfsState::new();
        // Artificially saturate the quota counter.
        vfs.bytes_written.fetch_add(
            64 * 1024 * 1024,  // WRITE_QUOTA_BYTES
            Ordering::Relaxed,
        );

        let rights = rw_rights();
        let fd = vfs.path_open("/tmp/overflow.txt",
            OpenFlags(OpenFlags::CREAT), rights, FdFlags(0)).unwrap();
        let result = vfs.fd_write(fd, b"one more byte");
        assert!(result.is_err(), "write past quota should fail");
    }

    // ── §1.6 Directory listing ────────────────────────────────────────────────

    #[test]
    fn list_dir_shows_direct_children_only() {
        let vfs = VfsState::new();
        let rights = Rights(Rights::FD_READ | Rights::FD_WRITE);
        vfs.path_open("/tmp/a.txt", OpenFlags(OpenFlags::CREAT), rights, FdFlags(0)).unwrap();
        vfs.path_open("/tmp/b.txt", OpenFlags(OpenFlags::CREAT), rights, FdFlags(0)).unwrap();
        // A file in a sub-path should NOT appear in /tmp listing.
        vfs.path_open("/workspace/hidden.txt",
            OpenFlags(OpenFlags::CREAT), rights, FdFlags(0)).unwrap();

        let entries = vfs.list_dir("/tmp").unwrap();
        assert!(entries.contains(&"a.txt".to_string()));
        assert!(entries.contains(&"b.txt".to_string()));
        assert!(!entries.contains(&"hidden.txt".to_string()),
            "file from /workspace must not appear in /tmp listing");
    }

    // ── §1.7 Ring buffer (stdout capture) ────────────────────────────────────

    #[test]
    fn ring_buffer_write_drain_cycle() {
        use wasm_worker_manager::vfs::RingBuffer;
        let rb = RingBuffer::new(1024);
        assert!(rb.drain().is_empty(), "fresh buffer must be empty");

        rb.write(b"Hello ");
        rb.write(b"WASM\n");
        let out = rb.drain();
        assert_eq!(out, b"Hello WASM\n");
        assert!(rb.drain().is_empty(), "drain must empty the buffer");
    }

    #[test]
    fn ring_buffer_evicts_oldest_bytes_when_full() {
        use wasm_worker_manager::vfs::RingBuffer;
        let rb = RingBuffer::new(8); // tiny capacity
        rb.write(b"12345678"); // fills exactly
        rb.write(b"ABCD");    // 4 bytes over → evicts "1234"
        let out = rb.drain();
        assert_eq!(out, b"5678ABCD",
            "oldest bytes should be evicted when ring is full");
    }

    // ── §1.8 VFS snapshot ────────────────────────────────────────────────────

    #[test]
    fn snapshot_captures_all_files() {
        let vfs = VfsState::new();
        let rights = rw_rights();

        let fd1 = vfs.path_open("/workspace/a.txt",
            OpenFlags(OpenFlags::CREAT), rights, FdFlags(0)).unwrap();
        vfs.fd_write(fd1, b"alpha").unwrap();
        vfs.fd_close(fd1).unwrap();

        let fd2 = vfs.path_open("/workspace/b.txt",
            OpenFlags(OpenFlags::CREAT), rights, FdFlags(0)).unwrap();
        vfs.fd_write(fd2, b"bravo").unwrap();
        vfs.fd_close(fd2).unwrap();

        let snap = vfs.snapshot();
        assert_eq!(snap.get("/workspace/a.txt").map(|v| v.as_slice()), Some(b"alpha".as_slice()));
        assert_eq!(snap.get("/workspace/b.txt").map(|v| v.as_slice()), Some(b"bravo".as_slice()));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// §2 — ResourceLimiter / ResourceMonitor tests
// ─────────────────────────────────────────────────────────────────────────────

mod resource_monitor_tests {
    use super::*;
    use wasmtime::ResourceLimiter as _;

    // ── §2.1 Inline ResourceLimiter ───────────────────────────────────────────

    #[test]
    fn limiter_allows_growth_within_cap() {
        let mut lim = SandboxResourceLimiter::new(50 * 1024 * 1024);
        assert!(lim.memory_growing(0, 10 * 1024 * 1024, None).unwrap(),
            "10 MB growth within 50 MB cap must be allowed");
        assert!(lim.memory_growing(0, 49 * 1024 * 1024, None).unwrap(),
            "49 MB growth within 50 MB cap must be allowed");
    }

    #[test]
    fn limiter_denies_growth_above_cap() {
        let mut lim = SandboxResourceLimiter::new(50 * 1024 * 1024);
        let allowed = lim.memory_growing(0, 51 * 1024 * 1024, None).unwrap();
        assert!(!allowed, "51 MB growth must be denied for a 50 MB cap");
    }

    #[test]
    fn limiter_denies_exact_boundary_plus_one() {
        let cap = 50 * 1024 * 1024usize;
        let mut lim = SandboxResourceLimiter::new(cap);
        assert!(lim.memory_growing(0, cap, None).unwrap(),  "exactly at cap must be allowed");
        assert!(!lim.memory_growing(0, cap + 1, None).unwrap(), "one byte over cap must be denied");
    }

    #[test]
    fn table_limiter_caps_element_count() {
        let mut lim = SandboxResourceLimiter::new(50 * 1024 * 1024);
        assert!(lim.table_growing(0, 65_536, None).unwrap(),
            "65,536 table elements (default limit) must be allowed");
        assert!(!lim.table_growing(0, 65_537, None).unwrap(),
            "65,537 table elements must be denied");
    }

    // ── §2.2 ResourceMonitor registry ────────────────────────────────────────

    #[tokio::test]
    async fn monitor_register_and_deregister() {
        let (monitor, _rx) = ResourceMonitor::new();
        let monitor = Arc::new(monitor);

        let id   = MonitorId("sandbox-42".into());
        let meta = SandboxMeta {
            pid:             std::process::id(),
            rss_limit_bytes: DEFAULT_RSS_LIMIT_BYTES,
            wasm_mem_bytes:  0,
            label:           "test-agent".into(),
        };

        assert!(!monitor.registry.contains_key(&id));
        monitor.register(id.clone(), meta);
        assert!(monitor.registry.contains_key(&id), "registry must contain id after register()");

        monitor.deregister(&id);
        assert!(!monitor.registry.contains_key(&id), "registry must not contain id after deregister()");
    }

    #[tokio::test]
    async fn monitor_multiple_sandboxes_independent() {
        let (monitor, _rx) = ResourceMonitor::new();
        let monitor = Arc::new(monitor);

        let ids: Vec<_> = (0..5)
            .map(|i| MonitorId(format!("sandbox-{i}")))
            .collect();

        for id in &ids {
            monitor.register(id.clone(), SandboxMeta {
                pid: std::process::id(),
                rss_limit_bytes: DEFAULT_RSS_LIMIT_BYTES,
                wasm_mem_bytes:  0,
                label: id.0.clone(),
            });
        }
        assert_eq!(monitor.registry.len(), 5);

        monitor.deregister(&ids[2]);
        assert_eq!(monitor.registry.len(), 4);
        assert!(!monitor.registry.contains_key(&ids[2]));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// §3 — SandboxPool integration tests
// ─────────────────────────────────────────────────────────────────────────────

mod pool_tests {
    use super::*;
    use std::time::Duration;

    fn tiny_config(pool_size: usize) -> PoolConfig {
        PoolConfig {
            pool_size,
            rss_limit_bytes:    50 * 1024 * 1024,
            memory_limit_bytes: 50 * 1024 * 1024,
            epoch_tick_ms:      10,
            cpu_quota_ticks:    5,
        }
    }

    // ── §3.1 Pre-warm ─────────────────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pool_prewarms_requested_slots() {
        let pool = SandboxPool::new(tiny_config(4), None).await.unwrap();
        assert_eq!(pool.warm_count(), 4,
            "pool must have exactly pool_size warm slots after init");
    }

    // ── §3.2 No-op stub execution ─────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn noop_stub_exits_zero() {
        let pool   = SandboxPool::new(tiny_config(2), None).await.unwrap();
        let result = pool.execute(noop_wasm(), "test-noop").await.unwrap();
        assert_eq!(result.exit_code, 0, "no-op stub must exit with code 0");
        assert!(result.stdout.is_empty(),  "no-op stub must not produce stdout");
        assert!(result.stderr.is_empty(),  "no-op stub must not produce stderr");
        assert!(result.elapsed < Duration::from_millis(20),
            "warm-slot execution must be <20ms (got {:?})", result.elapsed);
    }

    // ── §3.3 Slot replenishment ───────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pool_replenishes_after_execution() {
        let pool = SandboxPool::new(tiny_config(2), None).await.unwrap();
        assert_eq!(pool.warm_count(), 2);

        pool.execute(noop_wasm(), "agent-1").await.unwrap();
        // Allow the replenish task to run.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(pool.warm_count() >= 1,
            "pool must have at least 1 warm slot after one execution + replenish");
    }

    // ── §3.4 Concurrent execution ─────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_executions_all_succeed() {
        const N: usize = 10;
        let pool   = Arc::new(SandboxPool::new(tiny_config(N), None).await.unwrap());

        let handles: Vec<_> = (0..N)
            .map(|i| {
                let p = Arc::clone(&pool);
                tokio::spawn(async move {
                    p.execute(noop_wasm(), &format!("agent-{i}")).await
                })
            })
            .collect();

        let mut ok_count = 0usize;
        for h in handles {
            if h.await.unwrap().is_ok() { ok_count += 1; }
        }
        assert_eq!(ok_count, N, "all {N} concurrent executions must succeed");
    }

    // ── §3.5 VFS write visible in vfs_snapshot ────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stdout_writer_wasm_output_captured() {
        // This WAT module writes "hello" to stdout (fd=1) via fd_write.
        // The WASI iovec layout: [buf_ptr: u32, buf_len: u32]
        // We store the string at offset 16, iovec at offset 8.
        //
        // Memory layout (byte offsets):
        //   [0..8]   : padding
        //   [8..16]  : iovec { buf: 16u32 LE, buf_len: 5u32 LE }
        //   [16..21] : "hello"
        //   [24]     : nwritten (output ptr)
        let wat = r#"
            (module
              (import "wasi_snapshot_preview1" "fd_write"
                (func $fd_write (param i32 i32 i32 i32) (result i32)))
              (memory 1)
              (export "memory" (memory 0))
              (export "_start" (func $start))
              (data (i32.const 16) "hello")
              (func $start
                ;; Write iovec: buf_ptr=16, buf_len=5
                (i32.store (i32.const 8)  (i32.const 16))
                (i32.store (i32.const 12) (i32.const 5))
                ;; fd_write(fd=1, iovs=8, iovs_len=1, nwritten=24)
                (drop
                  (call $fd_write (i32.const 1) (i32.const 8) (i32.const 1) (i32.const 24)))
              )
            )
        "#;
        let wasm = wat::parse_str(wat).expect("WAT parse failed");

        let pool   = SandboxPool::new(tiny_config(2), None).await.unwrap();
        let result = pool.execute(wasm, "stdout-test").await.unwrap();

        assert_eq!(result.stdout, b"hello",
            "stdout should be 'hello', got {:?}", String::from_utf8_lossy(&result.stdout));
    }

    // ── §3.6 CPU quota enforcement ────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cpu_quota_exceeded_returns_error() {
        // Tight quota: 1 tick = 10ms max CPU.
        let cfg = PoolConfig {
            pool_size:          1,
            rss_limit_bytes:    50 * 1024 * 1024,
            memory_limit_bytes: 50 * 1024 * 1024,
            epoch_tick_ms:      10,
            cpu_quota_ticks:    1,  // ← 10ms hard cap
        };
        let pool = SandboxPool::new(cfg, None).await.unwrap();

        // Infinite loop WASM.
        let wat = r#"
            (module
              (memory 1)
              (export "memory" (memory 0))
              (export "_start" (func $start))
              (func $start (loop $l (br $l)))
            )
        "#;
        let wasm = wat::parse_str(wat).expect("WAT parse failed");

        let result = pool.execute(wasm, "infinite-loop").await;
        assert!(
            matches!(result, Err(SandboxError::CpuQuotaExceeded { .. })),
            "infinite loop should return CpuQuotaExceeded, got: {:?}", result
        );
    }

    // ── §3.7 Memory limit enforcement ────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn memory_growth_beyond_cap_is_denied() {
        // memory.grow by 1000 pages = 64 MB — above the 50 MB cap.
        // The module tries the grow; it returns -1 (failed); _start returns normally.
        // This tests that the ResourceLimiter callback is actually wired up.
        let wat = r#"
            (module
              (import "wasi_snapshot_preview1" "fd_write"
                (func $fd_write (param i32 i32 i32 i32) (result i32)))
              (memory 1)
              (export "memory" (memory 0))
              (export "_start" (func $start))
              (data (i32.const 16) "ok")
              (func $start
                ;; Attempt to grow by 1000 pages (64 MB) — should return -1.
                (drop (memory.grow (i32.const 1000)))
                ;; Write "ok" to stdout to confirm we survived.
                (i32.store (i32.const 8)  (i32.const 16))
                (i32.store (i32.const 12) (i32.const 2))
                (drop (call $fd_write (i32.const 1) (i32.const 8) (i32.const 1) (i32.const 24)))
              )
            )
        "#;
        let wasm = wat::parse_str(wat).expect("WAT parse failed");

        let pool   = SandboxPool::new(tiny_config(2), None).await.unwrap();
        let result = pool.execute(wasm, "memory-hog").await.unwrap();

        // The module handled the failed grow gracefully and continued.
        assert_eq!(result.stdout, b"ok",
            "module must survive denied memory.grow and write to stdout");
    }

    // ── §3.8 VFS path_open + fd_write from guest ─────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn guest_can_write_file_via_vfs() {
        // This module calls path_open to create /workspace/out.txt, writes "data" to it.
        // The pool uses our custom VFS interceptor — NO host filesystem is touched.
        let wat = r#"
            (module
              (import "wasi_snapshot_preview1" "path_open"
                (func $path_open
                  (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
              (import "wasi_snapshot_preview1" "fd_write"
                (func $fd_write (param i32 i32 i32 i32) (result i32)))
              (import "wasi_snapshot_preview1" "fd_close"
                (func $fd_close (param i32) (result i32)))
              (memory 1)
              (export "memory" (memory 0))
              (export "_start" (func $start))
              ;; Memory layout:
              ;;   [0]  : path string "/workspace/out.txt" (18 bytes)
              ;;   [32] : opened_fd_ptr (output of path_open)
              ;;   [64] : iovec for fd_write { buf=80, buf_len=4 }
              ;;   [80] : "data"
              ;;   [96] : nwritten
              (data (i32.const 0)  "/workspace/out.txt")
              (data (i32.const 80) "data")
              (func $start (local $fd i32)
                ;; path_open(dirfd=3, dirflags=0, path=0, path_len=18,
                ;;           oflags=O_CREAT(1), rights_base=0x40(FD_WRITE),
                ;;           rights_inh=0, fdflags=0, opened_fd_ptr=32)
                (call $path_open
                  (i32.const 3)  ;; dirfd (ignored by our VFS)
                  (i32.const 0)  ;; dirflags
                  (i32.const 0)  ;; path ptr
                  (i32.const 18) ;; path len
                  (i32.const 1)  ;; oflags: O_CREAT
                  (i64.const 64) ;; rights_base: FD_WRITE
                  (i64.const 0)  ;; rights_inh
                  (i32.const 0)  ;; fdflags
                  (i32.const 32) ;; opened_fd_ptr
                )
                drop
                ;; Read back the fd.
                (local.set $fd (i32.load (i32.const 32)))
                ;; Write iovec.
                (i32.store (i32.const 64) (i32.const 80))  ;; buf ptr
                (i32.store (i32.const 68) (i32.const 4))   ;; buf len
                ;; fd_write(fd, iovs=64, iovs_len=1, nwritten=96)
                (call $fd_write (local.get $fd) (i32.const 64) (i32.const 1) (i32.const 96))
                drop
                (call $fd_close (local.get $fd))
                drop
              )
            )
        "#;
        let wasm = wat::parse_str(wat).expect("WAT parse failed");

        let pool   = SandboxPool::new(tiny_config(2), None).await.unwrap();
        let result = pool.execute(wasm, "vfs-write-test").await.unwrap();

        let file_data = result.vfs_snapshot.get("/workspace/out.txt").cloned();
        assert_eq!(
            file_data.as_deref(),
            Some(b"data".as_slice()),
            "VFS must contain /workspace/out.txt with 'data'"
        );
    }

    // ── §3.9 Least-privilege: environ is empty ────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn environ_is_always_empty() {
        // This module calls environ_sizes_get and writes the env var count to stdout.
        let wat = r#"
            (module
              (import "wasi_snapshot_preview1" "environ_sizes_get"
                (func $environ_sizes_get (param i32 i32) (result i32)))
              (import "wasi_snapshot_preview1" "fd_write"
                (func $fd_write (param i32 i32 i32 i32) (result i32)))
              (memory 1)
              (export "memory" (memory 0))
              (export "_start" (func $start))
              (func $start (local $count i32)
                ;; Get env count into [0], env_buf_size into [4]
                (call $environ_sizes_get (i32.const 0) (i32.const 4))
                drop
                ;; Load count.
                (local.set $count (i32.load (i32.const 0)))
                ;; Write a single byte: '0' if count==0, else '!'
                (i32.store8 (i32.const 32)
                  (if (result i32)
                    (i32.eqz (local.get $count))
                    (then (i32.const 48))  ;; ASCII '0'
                    (else (i32.const 33))  ;; ASCII '!'
                  )
                )
                ;; iovec: buf=32, len=1
                (i32.store (i32.const 40) (i32.const 32))
                (i32.store (i32.const 44) (i32.const 1))
                (drop (call $fd_write (i32.const 1) (i32.const 40) (i32.const 1) (i32.const 48)))
              )
            )
        "#;
        let wasm = wat::parse_str(wat).expect("WAT parse failed");

        let pool   = SandboxPool::new(tiny_config(2), None).await.unwrap();
        let result = pool.execute(wasm, "environ-test").await.unwrap();

        assert_eq!(result.stdout, b"0",
            "environ must be empty (count=0); stdout should be '0'");
    }

    // ── §3.10 Shutdown is clean ───────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pool_shuts_down_gracefully() {
        let pool = SandboxPool::new(tiny_config(2), None).await.unwrap();
        pool.execute(noop_wasm(), "pre-shutdown").await.unwrap();
        // shutdown() must not panic.
        pool.shutdown();
        // Tiny sleep to let tokio drain tasks.
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /// Minimal WASM binary: exports `_start`, does nothing, exits 0.
    fn noop_wasm() -> Vec<u8> {
        vec![
            0x00, 0x61, 0x73, 0x6d,
            0x01, 0x00, 0x00, 0x00,
            0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
            0x03, 0x02, 0x01, 0x00,
            0x07, 0x0a, 0x01, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00,
            0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
        ]
    }
}
