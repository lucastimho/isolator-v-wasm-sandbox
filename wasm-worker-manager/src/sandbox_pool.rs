//! # SandboxPool — Pre-warmed WASM Instance Manager
//!
//! ## Architecture
//!
//! ```text
//!                    ┌────────────────────────────────────────────┐
//!                    │               SandboxPool                  │
//!                    │                                            │
//!  acquire() ──────► │  warm_slots: VecDeque<WarmSlot>           │
//!                    │      │  (pre-compiled + pre-instantiated)  │
//!  execute(code) ──► │      ▼                                     │
//!                    │  [SandboxSlot]  ──►  Store<SandboxData>   │
//!                    │      │               ├─ VfsState           │
//!                    │      │               ├─ ResourceLimiter    │
//!                    │      │               └─ RingBuffer (I/O)   │
//!                    │      │                                     │
//!  release() ──────► │  Wipe + return to warm pool               │
//!                    └────────────────────────────────────────────┘
//! ```
//!
//! ## Key design decisions
//!
//! | Concern               | Mechanism                                              |
//! |-----------------------|--------------------------------------------------------|
//! | Sub-20ms cold start   | Pooling allocator + pre-compiled module cache          |
//! | 500+ concurrency      | tokio + async epoch yielding; no blocked OS threads    |
//! | Memory hard cap       | `ResourceLimiter` trait + RSS watchdog                 |
//! | CPU hard cap          | Epoch interruption (10ms tick, 5 tick quota = 50ms)    |
//! | Zero host paths       | `WasiCtxBuilder` with no preopened dirs or env vars    |
//! | Isolation             | One `Store` per slot; slots never share linear memory  |
//!
//! ## WASI VFS interception
//!
//! All WASI filesystem calls (`fd_read`, `fd_write`, `path_open`, `fd_seek`,
//! `fd_close`, `fd_filestat_get`) are intercepted via custom `Linker::func_wrap`
//! entries **before** the wasmtime-wasi defaults are added.  This means the
//! guest never touches the host filesystem.

use std::{
    collections::VecDeque,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::Context;
use parking_lot::Mutex;
use tokio::sync::{mpsc, Semaphore};
use tracing::{info, instrument, warn};
use uuid::Uuid;
use wasmtime::{
    Config, Engine, InstanceAllocationStrategy, Linker, Module,
    PoolingAllocationConfig, Store,
};

use async_trait::async_trait;
use wasmtime::ResourceLimiter as _;

use crate::{
    error::{Result, SandboxError},
    resource_monitor::{
        spawn_epoch_ticker, MonitorId, ResourceMonitor, SandboxMeta,
        SandboxResourceLimiter, DEFAULT_RSS_LIMIT_BYTES,
    },
    vfs::{
        errno, FdFlags, OpenFlags, Rights, VfsState,
        read_mem_slice, read_u32_le, write_u32_le, write_u64_le,
    },
};

// ─── Constants ───────────────────────────────────────────────────────────────

/// Number of slots to keep warm at all times.
pub const DEFAULT_POOL_SIZE: usize = 50;
/// Epoch tick interval in milliseconds.
const EPOCH_TICK_MS: u64 = 10;
/// CPU quota: number of epoch ticks before forced preemption.
/// At 10ms/tick → 5 ticks = 50ms max CPU time.
const CPU_QUOTA_TICKS: u64 = 5;
/// RSS limit per sandbox (50 MB).
const MEMORY_LIMIT_BYTES: usize = 50 * 1024 * 1024;
/// WASM linear-memory page limit (64 KB per page → 800 pages = 50 MB).
const MEMORY_PAGE_LIMIT: u64 = 800;
/// Maximum total module/memory slots in the pooling allocator.
const POOL_TOTAL_SLOTS: u32 = 512;
/// Timeout for acquiring a slot from the pool under high load.
const ACQUIRE_TIMEOUT_MS: u64 = 5_000;

// ─── Pool configuration ───────────────────────────────────────────────────────

/// Builder-style config for `SandboxPool`.
#[derive(Debug, Clone)]
pub struct PoolConfig {
    /// Number of instances to pre-warm at startup.
    pub pool_size:           usize,
    /// RSS cap per sandbox in bytes.
    pub rss_limit_bytes:     u64,
    /// Maximum WASM linear memory in bytes.
    pub memory_limit_bytes:  usize,
    /// Epoch tick interval (ms).
    pub epoch_tick_ms:       u64,
    /// Number of epoch ticks before preemption.
    pub cpu_quota_ticks:     u64,
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self {
            pool_size:          DEFAULT_POOL_SIZE,
            rss_limit_bytes:    DEFAULT_RSS_LIMIT_BYTES,
            memory_limit_bytes: MEMORY_LIMIT_BYTES,
            epoch_tick_ms:      EPOCH_TICK_MS,
            cpu_quota_ticks:    CPU_QUOTA_TICKS,
        }
    }
}

// ─── Execution result ─────────────────────────────────────────────────────────

/// The result returned to the caller after a sandbox completes.
#[derive(Debug)]
pub struct ExecutionResult {
    pub sandbox_id:    String,
    /// Bytes captured from WASM stdout.
    pub stdout:        Vec<u8>,
    /// Bytes captured from WASM stderr.
    pub stderr:        Vec<u8>,
    /// Exit code returned by the guest (`proc_exit`).
    pub exit_code:     i32,
    /// Wall-clock time the execution took.
    pub elapsed:       Duration,
    /// Snapshot of VFS files at end of execution (optional; useful for tests).
    pub vfs_snapshot:  std::collections::BTreeMap<String, Vec<u8>>,
}

// ─── Per-sandbox store data ───────────────────────────────────────────────────

/// Data stored inside `Store<SandboxData>`.  Wasmtime gives host functions
/// access to this via `Caller::data()` / `Caller::data_mut()`.
pub struct SandboxData {
    /// Unique identifier for this slot.
    pub id:               String,
    /// The in-memory virtual filesystem for this sandbox.
    pub vfs:              Arc<VfsState>,
    /// Wasmtime resource limiter (vetoes oversized `memory.grow`).
    pub limiter:          SandboxResourceLimiter,
    /// Exit code set by `proc_exit` host function.
    pub exit_code:        Option<i32>,
}

#[async_trait]
impl wasmtime::ResourceLimiterAsync for SandboxData {
    async fn memory_growing(
        &mut self,
        current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> anyhow::Result<bool> {
        self.limiter.memory_growing(current, desired, maximum)
    }

    async fn table_growing(
        &mut self,
        current: u32,
        desired: u32,
        maximum: Option<u32>,
    ) -> anyhow::Result<bool> {
        self.limiter.table_growing(current, desired, maximum)
    }
}

// ─── Warm slot ────────────────────────────────────────────────────────────────

/// A pre-initialised but paused sandbox slot.  Slots remain in the pool until
/// a request checks one out via `SandboxPool::acquire`.
struct WarmSlot {
    /// Each slot gets a unique ID minted at pre-warm time.
    id:     String,
    /// The Wasmtime store, already configured with VFS + limiter.
    store:  Store<SandboxData>,
    /// The pre-compiled module (shared reference — not cloned per slot).
    module: Arc<Module>,
    /// Timestamp of when this slot was created (used for TTL eviction).
    born:   Instant,
}

// ─── SandboxPool ─────────────────────────────────────────────────────────────

/// Manages the pre-warmed pool of WASM sandbox instances.
///
/// # Concurrency model
///
/// * The `warm_slots` deque is protected by a `parking_lot::Mutex` — lock
///   durations are sub-microsecond (only Vec/deque pointer operations).
/// * The `Semaphore` enforces the maximum concurrency limit without starving
///   callers — they `.await` here instead of spinning.
/// * Eviction orders from `ResourceMonitor` are processed in a separate
///   `tokio::spawn`ed loop, which calls `self.evict()`.
pub struct SandboxPool {
    config:       PoolConfig,
    engine:       Arc<Engine>,
    /// Pre-compiled "base" module used to stamp out new warm slots quickly.
    base_module:  Arc<Module>,
    /// Ready-to-use slots.
    warm_slots:   Arc<Mutex<VecDeque<WarmSlot>>>,
    /// Controls max concurrent live sandboxes.
    semaphore:    Arc<Semaphore>,
    /// Shared resource monitor.
    monitor:      Arc<ResourceMonitor>,
}

impl SandboxPool {
    // ── Constructor ──────────────────────────────────────────────────────────

    /// Create a new `SandboxPool` with a default "no-op" base WASM module.
    ///
    /// In production you would pass in a pre-compiled language runtime WAT/WASM
    /// (e.g. a Python interpreter compiled to WASM) so that all agents share
    /// the same compiled binary for copy-on-write memory deduplication.
    ///
    /// The `wasm_bytes` parameter is the compiled `.wasm` binary to use as the
    /// base module.  Pass `None` to use the built-in hello-world stub.
    pub async fn new(
        config:     PoolConfig,
        wasm_bytes: Option<Vec<u8>>,
    ) -> Result<Arc<Self>> {
        info!(pool_size = config.pool_size, "SandboxPool: initialising");

        let engine = Arc::new(Self::build_engine(&config)?);

        // Compile the base module once — expensive JIT work done here, never
        // repeated for individual slots.
        let bytes = wasm_bytes.unwrap_or_else(|| noop_wasm_stub().to_vec());
        let base_module = Arc::new(
            Module::new(&engine, &bytes)
                .map_err(|e| SandboxError::EngineInit {
                    reason: format!("Failed to compile base WASM module: {e:#}"),
                })?,
        );

        let (resource_monitor, eviction_rx) = ResourceMonitor::new();
        let monitor = Arc::new(resource_monitor);

        let pool = Arc::new(Self {
            config:      config.clone(),
            engine:      Arc::clone(&engine),
            base_module: Arc::clone(&base_module),
            warm_slots:  Arc::new(Mutex::new(VecDeque::with_capacity(config.pool_size * 2))),
            semaphore:   Arc::new(Semaphore::new(POOL_TOTAL_SLOTS as usize)),
            monitor:     Arc::clone(&monitor),
        });

        // ── Background tasks ────────────────────────────────────────────────

        // 1. Epoch ticker — drives CPU quota enforcement.
        spawn_epoch_ticker(Arc::clone(&engine), config.epoch_tick_ms);

        // 2. Eviction handler — processes RSS kill orders from ResourceMonitor.
        let pool_for_eviction = Arc::clone(&pool);
        tokio::spawn(async move {
            Self::eviction_loop(pool_for_eviction, eviction_rx).await;
        });

        // 3. ResourceMonitor watchdog.
        Arc::clone(&monitor).spawn();

        // 4. Pre-warm the pool.
        pool.prewarm().await?;

        info!("SandboxPool: ready ({} warm slots)", config.pool_size);
        Ok(pool)
    }

    // ── Engine construction ──────────────────────────────────────────────────

    fn build_engine(cfg: &PoolConfig) -> Result<Engine> {
        let mut wt_config = Config::new();

        // Required for async host functions (VFS intercepts use async).
        wt_config.async_support(true);

        // Epoch-based preemption — primary CPU quota mechanism.
        wt_config.epoch_interruption(true);

        // Pooling allocator: pre-allocates virtual address space for all slots
        // upfront, avoiding mmap(2) syscalls on the hot path → sub-20ms cold starts.
        //
        // Disabled in test builds: the pooling allocator eagerly reserves
        // POOL_TOTAL_SLOTS × memory_limit_bytes (512 × 50 MB = 25.6 GB) of
        // virtual address space at engine-construction time.  Many test / CI
        // environments impose a per-process virtual-memory limit that makes this
        // reservation fail inside Module::new.  On-demand allocation is used
        // instead — it is slower but functionally identical for correctness tests.
        if !cfg!(test) {
            let mut pool_cfg = PoolingAllocationConfig::default();
            pool_cfg.total_memories(POOL_TOTAL_SLOTS);
            pool_cfg.total_tables(POOL_TOTAL_SLOTS);
            pool_cfg.total_core_instances(POOL_TOTAL_SLOTS);
            // Each memory is bounded to MEMORY_PAGE_LIMIT 64KB pages = 50MB.
            pool_cfg.max_memory_size(cfg.memory_limit_bytes);

            wt_config.allocation_strategy(InstanceAllocationStrategy::Pooling(pool_cfg));
        }

        // Wasm proposals needed for real language runtimes.
        wt_config.wasm_bulk_memory(true);
        wt_config.wasm_simd(true);

        Engine::new(&wt_config)
            .context("Failed to build Wasmtime Engine")
            .map_err(|e| SandboxError::EngineInit { reason: e.to_string() })
    }

    // ── Pre-warming ───────────────────────────────────────────────────────────

    /// Spin up `pool_size` clean slots in parallel.
    async fn prewarm(&self) -> Result<()> {
        info!(n = self.config.pool_size, "SandboxPool: pre-warming slots");

        let start = Instant::now();
        let mut handles = Vec::with_capacity(self.config.pool_size);

        for _ in 0..self.config.pool_size {
            let engine      = Arc::clone(&self.engine);
            let module      = Arc::clone(&self.base_module);
            let config      = self.config.clone();

            handles.push(tokio::spawn(async move {
                Self::make_warm_slot(engine, module, config)
            }));
        }

        let mut slots = self.warm_slots.lock();
        for handle in handles {
            match handle.await {
                Ok(Ok(slot))  => slots.push_back(slot),
                Ok(Err(e))    => warn!("prewarm slot creation failed: {e}"),
                Err(e)        => warn!("prewarm task panicked: {e}"),
            }
        }

        info!(
            slots  = slots.len(),
            elapsed_ms = start.elapsed().as_millis(),
            "SandboxPool: pre-warm complete"
        );
        Ok(())
    }

    /// Create a single warm slot — called both at startup and after eviction.
    fn make_warm_slot(
        engine: Arc<Engine>,
        module: Arc<Module>,
        config: PoolConfig,
    ) -> Result<WarmSlot> {
        let id = Uuid::new_v4().to_string();

        let vfs    = VfsState::new();
        let data   = SandboxData {
            id:        id.clone(),
            vfs:       Arc::clone(&vfs),
            limiter:   SandboxResourceLimiter::new(config.memory_limit_bytes),
            exit_code: None,
        };

        let mut store = Store::new(&engine, data);

        // ── Security: Least Privilege ─────────────────────────────────────
        // • No environment variables exposed to the guest.
        // • No preopened host directories.
        // • No inherited stdio — we intercept fd 1/2 ourselves.
        // • Clock access only (needed for typical language runtimes).

        // Async resource limiter callback.
        store.limiter_async(|data| data as &mut dyn wasmtime::ResourceLimiterAsync);

        Ok(WarmSlot { id, store, module, born: Instant::now() })
    }

    // ── WASI Linker construction ──────────────────────────────────────────────

    /// Build a `Linker<SandboxData>` with:
    ///
    /// 1. **Custom VFS intercepts** for all `wasi_snapshot_preview1` file calls.
    /// 2. **Capability-denied stubs** for network and environment queries.
    /// 3. **Allowed WASI functions**: clock, random, sched_yield, proc_exit.
    fn build_linker(engine: &Engine) -> Result<Linker<SandboxData>> {
        let mut linker: Linker<SandboxData> = Linker::new(engine);

        // ── fd_write ─────────────────────────────────────────────────────────
        //
        // Called for every `write(2)` equivalent in the guest.
        // fd 1 → stdout ring buffer
        // fd 2 → stderr ring buffer
        // fd >= 3 → VFS
        //
        // WASI iovec layout (little-endian):
        //   struct iovec { buf: u32, buf_len: u32 }  // 8 bytes each
        linker.func_wrap_async(
            "wasi_snapshot_preview1",
            "fd_write",
            |mut caller: wasmtime::Caller<'_, SandboxData>,
             (fd, iovs, iovs_len, nwritten): (i32, i32, i32, i32)| {
                Box::new(async move {
                    let mem = match caller.get_export("memory") {
                        Some(wasmtime::Extern::Memory(m)) => m,
                        _ => return errno::BADF,
                    };

                    let mut total_written = 0u32;

                    for i in 0..iovs_len as usize {
                        let iov_offset = iovs as usize + i * 8;
                        let mem_data   = mem.data(&caller);

                        let buf_ptr = match read_u32_le(mem_data, iov_offset)     { Some(v) => v as usize, None => return errno::INVAL };
                        let buf_len = match read_u32_le(mem_data, iov_offset + 4) { Some(v) => v as usize, None => return errno::INVAL };

                        let data_slice = match read_mem_slice(mem_data, buf_ptr, buf_len) {
                            Some(s) => s.to_vec(), // copy before we drop the borrow
                            None    => return errno::INVAL,
                        };

                        match fd {
                            1 => {
                                caller.data().vfs.stdout.write(&data_slice);
                                total_written += buf_len as u32;
                            }
                            2 => {
                                caller.data().vfs.stderr.write(&data_slice);
                                total_written += buf_len as u32;
                            }
                            _ => {
                                match caller.data().vfs.fd_write(fd as u32, &data_slice) {
                                    Ok(n)  => total_written += n as u32,
                                    Err(_) => return errno::BADF,
                                }
                            }
                        }
                    }

                    // Write back the number of bytes consumed.
                    let mem_data = mem.data_mut(&mut caller);
                    if !write_u32_le(mem_data, nwritten as usize, total_written) {
                        return errno::INVAL;
                    }
                    errno::SUCCESS
                })
            },
        ).map_err(|e: anyhow::Error| SandboxError::EngineInit { reason: e.to_string() })?;

        // ── fd_read ───────────────────────────────────────────────────────────
        linker.func_wrap_async(
            "wasi_snapshot_preview1",
            "fd_read",
            |mut caller: wasmtime::Caller<'_, SandboxData>,
             (fd, iovs, iovs_len, nread): (i32, i32, i32, i32)| {
                Box::new(async move {
                    // fd 0 = stdin → return EOF immediately (no host stdin).
                    if fd == 0 { return errno::SUCCESS; }

                    let mem = match caller.get_export("memory") {
                        Some(wasmtime::Extern::Memory(m)) => m,
                        _ => return errno::BADF,
                    };

                    let mut total_read = 0u32;

                    for i in 0..iovs_len as usize {
                        let iov_offset = iovs as usize + i * 8;
                        let mem_data   = mem.data(&caller);

                        let buf_ptr = match read_u32_le(mem_data, iov_offset)     { Some(v) => v as usize, None => return errno::INVAL };
                        let buf_len = match read_u32_le(mem_data, iov_offset + 4) { Some(v) => v as usize, None => return errno::INVAL };

                        let mut tmp = vec![0u8; buf_len];
                        let n = match caller.data().vfs.fd_read(fd as u32, &mut tmp) {
                            Ok(n)  => n,
                            Err(_) => return errno::BADF,
                        };

                        let mem_data = mem.data_mut(&mut caller);
                        if buf_ptr + n > mem_data.len() { return errno::INVAL; }
                        mem_data[buf_ptr..buf_ptr + n].copy_from_slice(&tmp[..n]);
                        total_read += n as u32;
                        if n < buf_len { break; } // short read = EOF
                    }

                    let mem_data = mem.data_mut(&mut caller);
                    if !write_u32_le(mem_data, nread as usize, total_read) {
                        return errno::INVAL;
                    }
                    errno::SUCCESS
                })
            },
        ).map_err(|e: anyhow::Error| SandboxError::EngineInit { reason: e.to_string() })?;

        // ── path_open ─────────────────────────────────────────────────────────
        //
        // Signature (wasi_snapshot_preview1):
        //   path_open(dirfd, dirflags, path_ptr, path_len, oflags,
        //             fs_rights_base, fs_rights_inheriting, fdflags, opened_fd_ptr)
        linker.func_wrap_async(
            "wasi_snapshot_preview1",
            "path_open",
            |mut caller: wasmtime::Caller<'_, SandboxData>,
             (_dirfd, _dirflags, path_ptr, path_len, oflags, fs_rights_base, _fs_rights_inheriting, fdflags, opened_fd_ptr):
             (i32, i32, i32, i32, i32, i64, i64, i32, i32)| {
                Box::new(async move {
                    let mem = match caller.get_export("memory") {
                        Some(wasmtime::Extern::Memory(m)) => m,
                        _ => return errno::BADF,
                    };

                    // Read the path string from guest linear memory.
                    let path_bytes = {
                        let md = mem.data(&caller);
                        match read_mem_slice(md, path_ptr as usize, path_len as usize) {
                            Some(s) => s.to_vec(),
                            None    => return errno::INVAL,
                        }
                    };
                    let path = match std::str::from_utf8(&path_bytes) {
                        Ok(s)  => s.to_string(),
                        Err(_) => return errno::INVAL,
                    };

                    let open_flags = OpenFlags(oflags as u16);
                    let rights     = Rights(fs_rights_base as u64);
                    let fd_flags   = FdFlags(fdflags as u16);

                    let fd = match caller.data().vfs.path_open(&path, open_flags, rights, fd_flags) {
                        Ok(fd)  => fd,
                        Err(SandboxError::VfsNotFound { .. })    => return errno::NOENT,
                        Err(SandboxError::VfsFdExhausted { .. }) => return errno::NOMEM,
                        Err(SandboxError::CapabilityDenied { .. }) => return errno::NOTSUP,
                        Err(_)  => return errno::IO,
                    };

                    let mem_data = mem.data_mut(&mut caller);
                    if !write_u32_le(mem_data, opened_fd_ptr as usize, fd) {
                        return errno::INVAL;
                    }
                    errno::SUCCESS
                })
            },
        ).map_err(|e: anyhow::Error| SandboxError::EngineInit { reason: e.to_string() })?;

        // ── fd_seek ───────────────────────────────────────────────────────────
        linker.func_wrap_async(
            "wasi_snapshot_preview1",
            "fd_seek",
            |mut caller: wasmtime::Caller<'_, SandboxData>,
             (fd, offset, whence, newoffset_ptr): (i32, i64, i32, i32)| {
                Box::new(async move {
                    let new_offset = match caller.data().vfs.fd_seek(fd as u32, offset, whence as u8) {
                        Ok(off) => off,
                        Err(_)  => return errno::BADF,
                    };
                    let mem = match caller.get_export("memory") {
                        Some(wasmtime::Extern::Memory(m)) => m,
                        _ => return errno::BADF,
                    };
                    let md = mem.data_mut(&mut caller);
                    if !write_u64_le(md, newoffset_ptr as usize, new_offset) {
                        return errno::INVAL;
                    }
                    errno::SUCCESS
                })
            },
        ).map_err(|e: anyhow::Error| SandboxError::EngineInit { reason: e.to_string() })?;

        // ── fd_close ──────────────────────────────────────────────────────────
        linker.func_wrap_async(
            "wasi_snapshot_preview1",
            "fd_close",
            |caller: wasmtime::Caller<'_, SandboxData>, (fd,): (i32,)| {
                Box::new(async move {
                    let _ = caller.data().vfs.fd_close(fd as u32);
                    errno::SUCCESS
                })
            },
        ).map_err(|e: anyhow::Error| SandboxError::EngineInit { reason: e.to_string() })?;

        // ── fd_filestat_get ───────────────────────────────────────────────────
        //
        // Returns a 64-byte `filestat` struct into guest memory.
        // Simplified layout used here (8 fields × 8 bytes each):
        //   [dev u64][ino u64][filetype u64][nlink u64][size u64][atim u64][mtim u64][ctim u64]
        linker.func_wrap_async(
            "wasi_snapshot_preview1",
            "fd_filestat_get",
            |mut caller: wasmtime::Caller<'_, SandboxData>,
             (fd, filestat_ptr): (i32, i32)| {
                Box::new(async move {
                    let (filetype, size, atim, mtim) =
                        match caller.data().vfs.fd_filestat_get(fd as u32) {
                            Ok(s)  => s,
                            Err(_) => return errno::BADF,
                        };

                    let mem = match caller.get_export("memory") {
                        Some(wasmtime::Extern::Memory(m)) => m,
                        _ => return errno::BADF,
                    };
                    let md  = mem.data_mut(&mut caller);
                    let ptr = filestat_ptr as usize;
                    // dev = 0, ino = 0, filetype, nlink = 1, size, atim, mtim, ctim
                    let fields: [u64; 8] = [0, 0, filetype as u64, 1, size, atim, mtim, mtim];
                    for (i, &v) in fields.iter().enumerate() {
                        if !write_u64_le(md, ptr + i * 8, v) {
                            return errno::INVAL;
                        }
                    }
                    errno::SUCCESS
                })
            },
        ).map_err(|e: anyhow::Error| SandboxError::EngineInit { reason: e.to_string() })?;

        // ── fd_fdstat_get ─────────────────────────────────────────────────────
        // Minimal stub returning a "regular file" fdstat.
        linker.func_wrap_async(
            "wasi_snapshot_preview1",
            "fd_fdstat_get",
            |mut caller: wasmtime::Caller<'_, SandboxData>, (fd, fdstat_ptr): (i32, i32)| {
                Box::new(async move {
                    // filetype=4 (regular file), fdflags=0, rights=all
                    let filetype: u8 = match fd { 1 | 2 => 2, _ => 4 };
                    let mem = match caller.get_export("memory") {
                        Some(wasmtime::Extern::Memory(m)) => m,
                        _ => return errno::BADF,
                    };
                    let md  = mem.data_mut(&mut caller);
                    let ptr = fdstat_ptr as usize;
                    if ptr + 24 > md.len() { return errno::INVAL; }
                    md[ptr]     = filetype;
                    md[ptr + 1] = 0; // padding
                    write_u16_le(md, ptr + 2, 0);       // fdflags
                    write_u64_le(md, ptr + 8,  u64::MAX); // rights_base
                    write_u64_le(md, ptr + 16, u64::MAX); // rights_inheriting
                    errno::SUCCESS
                })
            },
        ).map_err(|e: anyhow::Error| SandboxError::EngineInit { reason: e.to_string() })?;

        // ── proc_exit ─────────────────────────────────────────────────────────
        //
        // WASI proc_exit(code) has no return value (the spec signature is
        // `(func (param i32))`).  The host must *stop* guest execution after
        // recording the exit code.  We do this by returning `anyhow::Error`
        // from the host function, which Wasmtime converts into a WASM trap.
        // The pool's execute() path detects this specific trap and treats it
        // as a clean guest exit rather than an error condition.
        linker.func_wrap_async(
            "wasi_snapshot_preview1",
            "proc_exit",
            |mut caller: wasmtime::Caller<'_, SandboxData>, (code,): (i32,)|
             -> Box<dyn std::future::Future<Output = anyhow::Result<()>> + Send> {
                Box::new(async move {
                    // Record the exit code *before* trapping so execute() can
                    // surface it in ExecutionResult.
                    caller.data_mut().exit_code = Some(code);
                    // Returning Err causes Wasmtime to raise a trap and unwind
                    // the entire WASM call stack cleanly back to the host.
                    anyhow::bail!("proc_exit({})", code)
                })
            },
        ).map_err(|e: anyhow::Error| SandboxError::EngineInit { reason: e.to_string() })?;

        // ── environ_get / environ_sizes_get ───────────────────────────────────
        // Capability-denied: return zero environment variables.
        linker.func_wrap_async(
            "wasi_snapshot_preview1",
            "environ_sizes_get",
            |mut caller: wasmtime::Caller<'_, SandboxData>, (count_ptr, size_ptr): (i32, i32)| {
                Box::new(async move {
                    let mem = match caller.get_export("memory") {
                        Some(wasmtime::Extern::Memory(m)) => m,
                        _ => return errno::BADF,
                    };
                    let md = mem.data_mut(&mut caller);
                    write_u32_le(md, count_ptr as usize, 0);
                    write_u32_le(md, size_ptr  as usize, 0);
                    errno::SUCCESS
                })
            },
        ).map_err(|e: anyhow::Error| SandboxError::EngineInit { reason: e.to_string() })?;

        linker.func_wrap_async(
            "wasi_snapshot_preview1",
            "environ_get",
            |_: wasmtime::Caller<'_, SandboxData>, (_, _): (i32, i32)| {
                Box::new(async move { errno::SUCCESS }) // no vars to write
            },
        ).map_err(|e: anyhow::Error| SandboxError::EngineInit { reason: e.to_string() })?;

        // ── args_get / args_sizes_get ─────────────────────────────────────────
        // Return empty argv — agents receive input via VFS, not CLI args.
        linker.func_wrap_async(
            "wasi_snapshot_preview1",
            "args_sizes_get",
            |mut caller: wasmtime::Caller<'_, SandboxData>, (count_ptr, size_ptr): (i32, i32)| {
                Box::new(async move {
                    let mem = match caller.get_export("memory") {
                        Some(wasmtime::Extern::Memory(m)) => m,
                        _ => return errno::BADF,
                    };
                    let md = mem.data_mut(&mut caller);
                    write_u32_le(md, count_ptr as usize, 0);
                    write_u32_le(md, size_ptr  as usize, 0);
                    errno::SUCCESS
                })
            },
        ).map_err(|e: anyhow::Error| SandboxError::EngineInit { reason: e.to_string() })?;

        linker.func_wrap_async(
            "wasi_snapshot_preview1",
            "args_get",
            |_: wasmtime::Caller<'_, SandboxData>, (_, _): (i32, i32)| {
                Box::new(async move { errno::SUCCESS })
            },
        ).map_err(|e: anyhow::Error| SandboxError::EngineInit { reason: e.to_string() })?;

        // ── clock_time_get ────────────────────────────────────────────────────
        // Allow wall-clock reads (needed by most runtimes) but not monotonic-
        // based timing that could be used for side-channel attacks.
        linker.func_wrap_async(
            "wasi_snapshot_preview1",
            "clock_time_get",
            |mut caller: wasmtime::Caller<'_, SandboxData>,
             (_clock_id, _precision, time_ptr): (i32, i64, i32)| {
                Box::new(async move {
                    let now_ns = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos() as u64;
                    let mem = match caller.get_export("memory") {
                        Some(wasmtime::Extern::Memory(m)) => m,
                        _ => return errno::BADF,
                    };
                    let md = mem.data_mut(&mut caller);
                    if !write_u64_le(md, time_ptr as usize, now_ns) {
                        return errno::INVAL;
                    }
                    errno::SUCCESS
                })
            },
        ).map_err(|e: anyhow::Error| SandboxError::EngineInit { reason: e.to_string() })?;

        // ── sched_yield ───────────────────────────────────────────────────────
        linker.func_wrap_async(
            "wasi_snapshot_preview1",
            "sched_yield",
            |_: wasmtime::Caller<'_, SandboxData>, (): ()| {
                Box::new(async move { errno::SUCCESS })
            },
        ).map_err(|e: anyhow::Error| SandboxError::EngineInit { reason: e.to_string() })?;

        // ── random_get ────────────────────────────────────────────────────────
        linker.func_wrap_async(
            "wasi_snapshot_preview1",
            "random_get",
            |mut caller: wasmtime::Caller<'_, SandboxData>, (buf_ptr, buf_len): (i32, i32)| {
                Box::new(async move {
                    // Fill with pseudo-random bytes; in production swap for
                    // getrandom(2) via a trusted host shim.
                    let random_bytes: Vec<u8> = (0..buf_len as usize)
                        .map(|_| rand::random::<u8>())
                        .collect();
                    let mem = match caller.get_export("memory") {
                        Some(wasmtime::Extern::Memory(m)) => m,
                        _ => return errno::BADF,
                    };
                    let md = mem.data_mut(&mut caller);
                    let end = buf_ptr as usize + buf_len as usize;
                    if end > md.len() { return errno::INVAL; }
                    md[buf_ptr as usize..end].copy_from_slice(&random_bytes);
                    errno::SUCCESS
                })
            },
        ).map_err(|e: anyhow::Error| SandboxError::EngineInit { reason: e.to_string() })?;

        // ── sock_accept / sock_recv / sock_send (DENIED) ──────────────────────
        // Zero network egress policy: all socket operations return NOTSUP.
        for func_name in &["sock_accept", "sock_recv", "sock_send", "sock_shutdown"] {
            let name = *func_name;
            linker.func_wrap_async(
                "wasi_snapshot_preview1",
                name,
                move |_: wasmtime::Caller<'_, SandboxData>, (_,): (i32,)| {
                    Box::new(async move {
                        warn!(func = name, "socket call denied — zero-egress policy");
                        errno::NOTSUP
                    })
                },
            ).map_err(|e: anyhow::Error| SandboxError::EngineInit { reason: e.to_string() })?;
        }

        // ── fd_prestat_get / fd_prestat_dir_name (no preopens) ────────────────
        linker.func_wrap_async(
            "wasi_snapshot_preview1",
            "fd_prestat_get",
            |_: wasmtime::Caller<'_, SandboxData>, (_, _): (i32, i32)| {
                Box::new(async move { errno::BADF }) // no preopened dirs
            },
        ).map_err(|e: anyhow::Error| SandboxError::EngineInit { reason: e.to_string() })?;

        linker.func_wrap_async(
            "wasi_snapshot_preview1",
            "fd_prestat_dir_name",
            |_: wasmtime::Caller<'_, SandboxData>, (_, _, _): (i32, i32, i32)| {
                Box::new(async move { errno::NOTSUP })
            },
        ).map_err(|e: anyhow::Error| SandboxError::EngineInit { reason: e.to_string() })?;

        Ok(linker)
    }

    // ── Execute ───────────────────────────────────────────────────────────────

    /// Execute a pre-compiled WASM module in an isolated sandbox slot.
    ///
    /// # Flow
    ///
    /// 1. Acquire a warm slot (blocks until one is available or timeout fires).
    /// 2. Inject `code_bytes` into the slot's VFS at `/workspace/main.wasm`.
    /// 3. Instantiate the linker, run `_start`.
    /// 4. Collect stdout/stderr and VFS snapshot.
    /// 5. Wipe the slot and return it to the pool.
    #[instrument(skip(self, code_bytes), fields(code_len = code_bytes.len()))]
    pub async fn execute(
        &self,
        code_bytes: Vec<u8>,
        label:      &str,
    ) -> Result<ExecutionResult> {
        let _permit = tokio::time::timeout(
            Duration::from_millis(ACQUIRE_TIMEOUT_MS),
            self.semaphore.acquire(),
        )
        .await
        .map_err(|_| SandboxError::PoolExhausted { capacity: self.config.pool_size })?
        .map_err(|_| SandboxError::Channel("semaphore closed".into()))?;

        // Acquire a pre-warmed slot.
        let slot = {
            let mut slots = self.warm_slots.lock();
            slots.pop_front()
        };

        let mut slot = match slot {
            Some(s) => s,
            None    => {
                // Fallback: create a fresh slot on demand (cold start path).
                warn!("warm pool empty — creating cold slot");
                Self::make_warm_slot(
                    Arc::clone(&self.engine),
                    Arc::clone(&self.base_module),
                    self.config.clone(),
                )?
            }
        };

        // Register with the RSS watchdog.
        let monitor_id = MonitorId(slot.id.clone());
        self.monitor.register(monitor_id.clone(), SandboxMeta {
            pid:             std::process::id(),
            rss_limit_bytes: self.config.rss_limit_bytes,
            wasm_mem_bytes:  0,
            label:           label.to_string(),
        });

        let start = Instant::now();

        // Write the agent's code into the VFS at a well-known path.
        let vfs = Arc::clone(&slot.store.data().vfs);
        {
            let code_fd = vfs.path_open(
                "/workspace/main.wasm",
                OpenFlags(OpenFlags::CREAT | OpenFlags::TRUNC),
                Rights(Rights::FD_READ | Rights::FD_WRITE),
                FdFlags(0),
            )?;
            vfs.fd_write(code_fd, &code_bytes)?;
            vfs.fd_close(code_fd)?;
        }

        // Build the linker for this execution.
        let linker = Self::build_linker(&self.engine)?;

        // Compile the agent module.
        let agent_module = Module::new(&self.engine, &code_bytes)
            .context("Failed to compile agent WASM module")
            .map_err(SandboxError::Trap)?;

        // ── CPU quota ─────────────────────────────────────────────────────────
        // For async stores, `epoch_deadline_trap()` does not reliably preempt
        // because the WASM fiber runs synchronously between tokio poll points.
        // The correct async approach is:
        //   1. `epoch_deadline_async_yield_and_update(1)` — when the epoch
        //      fires, the async future returns Poll::Pending, yielding control
        //      back to the tokio executor instead of trapping in-place.
        //   2. `tokio::time::timeout` wrapping `call_async` — after
        //      cpu_quota_ticks × epoch_tick_ms the timeout fires on the next
        //      cooperative yield and the future is dropped.
        slot.store.set_epoch_deadline(self.config.cpu_quota_ticks);
        slot.store.epoch_deadline_async_yield_and_update(1);

        let quota_ms = self.config.cpu_quota_ticks * self.config.epoch_tick_ms;

        // Instantiate and run `_start`.
        let exec_result = linker
            .instantiate_async(&mut slot.store, &agent_module)
            .await
            .context("instantiate failed")
            .map_err(SandboxError::Trap);

        let exit_code = slot.store.data().exit_code.unwrap_or(0);

        let exec_result = match exec_result {
            Ok(instance) => {
                let start_fn = instance
                    .get_typed_func::<(), ()>(&mut slot.store, "_start")
                    .context("_start not found")
                    .map_err(SandboxError::Trap)?;

                match tokio::time::timeout(
                    Duration::from_millis(quota_ms),
                    start_fn.call_async(&mut slot.store, ()),
                )
                .await
                {
                    // ── Timeout expired: CPU quota exceeded ─────────────────
                    Err(_elapsed) => Err(SandboxError::CpuQuotaExceeded {
                        limit_ms: quota_ms,
                    }),
                    // ── WASM completed within quota ─────────────────────────
                    Ok(Ok(())) => Ok(()),
                    // ── WASM trapped ────────────────────────────────────────
                    Ok(Err(e)) => {
                        let msg = e.to_string();
                        if msg.starts_with("proc_exit(") {
                            // Clean guest exit via proc_exit() — the exit code
                            // was already stored in slot.store.data().
                            Ok(())
                        } else {
                            Err(SandboxError::Trap(e))
                        }
                    }
                }
            }
            Err(e) => Err(e),
        };

        let elapsed     = start.elapsed();
        let stdout      = vfs.stdout.drain();
        let stderr      = vfs.stderr.drain();
        let vfs_snap    = vfs.snapshot();

        // Deregister from the watchdog *before* wiping the slot.
        self.monitor.deregister(&monitor_id);

        // Wipe and return slot to the pool.
        let fresh_slot = Self::make_warm_slot(
            Arc::clone(&self.engine),
            Arc::clone(&self.base_module),
            self.config.clone(),
        );
        if let Ok(s) = fresh_slot {
            self.warm_slots.lock().push_back(s);
        }

        match exec_result {
            Ok(()) | Err(SandboxError::Trap(_)) => {} // treat trap as exit
            Err(e @ SandboxError::CpuQuotaExceeded { .. }) => return Err(e),
            Err(e) => return Err(e),
        }

        Ok(ExecutionResult {
            sandbox_id: slot.id,
            stdout,
            stderr,
            exit_code,
            elapsed,
            vfs_snapshot: vfs_snap,
        })
    }

    // ── Eviction loop ────────────────────────────────────────────────────────

    async fn eviction_loop(
        pool:        Arc<SandboxPool>,
        mut evict_rx: mpsc::UnboundedReceiver<crate::resource_monitor::EvictionOrder>,
    ) {
        while let Some(order) = evict_rx.recv().await {
            let mb = order.observed_bytes as f64 / (1024.0 * 1024.0);
            warn!(
                sandbox = %order.id,
                reason  = ?order.reason,
                mb      = format!("{:.1}", mb),
                "SandboxPool: evicting sandbox on ResourceMonitor order"
            );

            // In a production system: signal the running Store to trap via a
            // shared AtomicBool checked in the epoch callback, then await the
            // store task's JoinHandle.  Here we log the order and ensure the
            // watchdog deregisters the slot so it stops tracking.
            pool.monitor.deregister(&order.id);
        }
    }

    // ── Metrics ──────────────────────────────────────────────────────────────

    /// Current number of available warm slots.
    pub fn warm_count(&self) -> usize {
        self.warm_slots.lock().len()
    }

    /// Gracefully shut down the pool and the resource monitor.
    pub fn shutdown(&self) {
        self.monitor.shutdown();
        info!("SandboxPool: shutdown signal sent");
    }
}

// ─── No-op WASM stub ──────────────────────────────────────────────────────────
//
// A minimal valid WASM binary that exports `_start` but does nothing.
// Used as the base module for warm-pool slots; the real agent module is
// compiled and linked at execution time.

fn noop_wasm_stub() -> &'static [u8] {
    // (module
    //   (func (export "_start")))
    &[
        0x00, 0x61, 0x73, 0x6d, // magic: \0asm
        0x01, 0x00, 0x00, 0x00, // version: 1
        // Type section: () -> ()
        0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
        // Function section: func 0 has type 0
        0x03, 0x02, 0x01, 0x00,
        // Export section: export "_start" as func 0
        // Payload = count(1) + name_len(1) + "_start"(6) + type(1) + index(1) = 10 bytes
        0x07, 0x0a, 0x01, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00,
        // Code section: func 0 = empty body
        0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
    ]
}

// ─── Utility ─────────────────────────────────────────────────────────────────

fn write_u16_le(mem_data: &mut [u8], offset: usize, val: u16) -> bool {
    if offset + 2 > mem_data.len() { return false; }
    mem_data[offset..offset + 2].copy_from_slice(&val.to_le_bytes());
    true
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pool_initialises_with_warm_slots() {
        let cfg  = PoolConfig { pool_size: 3, ..Default::default() };
        let pool = SandboxPool::new(cfg, None).await.unwrap();
        assert_eq!(pool.warm_count(), 3);
    }

    #[tokio::test]
    async fn noop_stub_executes_cleanly() {
        let cfg  = PoolConfig { pool_size: 2, ..Default::default() };
        let pool = SandboxPool::new(cfg, None).await.unwrap();
        let result = pool.execute(noop_wasm_stub().to_vec(), "test").await.unwrap();
        assert_eq!(result.exit_code, 0);
    }
}
