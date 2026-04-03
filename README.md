# Isolator-V — WASM Worker Manager

> **A production-grade, high-concurrency WebAssembly sandbox execution engine for secure, ephemeral AI agent workloads.**

[![Rust](https://img.shields.io/badge/Rust-2021%20Edition-orange?logo=rust)](https://www.rust-lang.org/)
[![Wasmtime](https://img.shields.io/badge/Wasmtime-25.0-blueviolet)](https://wasmtime.dev/)
[![Tokio](https://img.shields.io/badge/Tokio-1.37-blue)](https://tokio.rs/)
[![Axum](https://img.shields.io/badge/Axum-0.7-green)](https://github.com/tokio-rs/axum)

---

## Overview

Isolator-V executes untrusted WebAssembly payloads inside fully isolated, ephemeral sandboxes. Each sandbox receives a clean virtual filesystem, a bounded CPU quota, a 50 MB memory cap, and zero access to the host OS. A pool of 50 pre-warmed slots ensures sub-20ms cold starts under sustained concurrency.

**Key properties:**

- **Zero host filesystem exposure** — all guest I/O is intercepted and routed through an in-memory VFS
- **Deterministic CPU quotas** — epoch-based preemption with a 50ms hard cap per execution
- **Defense-in-depth security** — 5 independent layers from kernel syscall filtering to output scrubbing
- **Lock-free hot path** — back-pressure admission control reads cached metrics with no blocking calls
- **9,600+ req/s** throughput at P99 < 20ms on a 50-slot pool

---

## Table of Contents

- [Architecture](#architecture)
- [Security Model](#security-model)
- [Execution Lifecycle](#execution-lifecycle)
- [API Reference](#api-reference)
- [Module Breakdown](#module-breakdown)
- [Configuration](#configuration)
- [Performance](#performance)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)

---

## Architecture

```mermaid
graph TD
    Client(["Client / AI Orchestrator"])

    subgraph HTTP["HTTP Layer (Axum 0.7)"]
        Execute["POST /execute"]
        Stream["GET /stream/:job_id"]
        Health["GET /health"]
        Metrics["GET /metrics"]
    end

    subgraph Guard["Admission Layer"]
        BP["BackPressureGuard\n(lock-free snapshot read)"]
        BP_BG["Background Sampler\n(tokio::spawn, 500ms)"]
    end

    subgraph Pool["SandboxPool (50 warm slots)"]
        Warm["WarmSlot VecDeque\n(parking_lot::Mutex)"]
        Sem["Semaphore(512)\n(concurrency cap)"]
        Epoch["Epoch Ticker\n(10ms preemption)"]
        RSS["RSS Watchdog\n(sysinfo, 50ms poll)"]
        Evict["Eviction Loop\n(mpsc channel)"]
    end

    subgraph Sandbox["Per-Sandbox (Wasmtime Store)"]
        WASI["WASI Linker\n(custom func_wrap_async)"]
        VFS["VFS\n(BTreeMap in-memory)"]
        Cap["CapabilityValidator\n(OCAP SessionPolicy)"]
        RLimit["ResourceLimiter\n(memory.grow veto)"]
        Ring["RingBuffer\n(stdout/stderr)"]
    end

    subgraph Output["Output Pipeline"]
        PII["PII Scrubber\n(16 regex patterns)"]
        SSE["SSE Bridge\n(20ms drain)"]
    end

    Client --> Execute
    Client --> Stream
    Client --> Health
    Client --> Metrics

    Execute --> BP
    BP_BG -.->|"writes snapshot"| BP
    BP -->|"admitted"| Pool

    Warm --> Sandbox
    Sem --> Warm
    Epoch -.->|"increment epoch"| Pool
    RSS -.->|"eviction order"| Evict
    Evict -.->|"kill slot"| Warm

    WASI --> VFS
    WASI --> Cap
    WASI --> RLimit
    WASI --> Ring

    Sandbox --> PII
    PII --> Client
    Ring --> SSE
    SSE --> Stream
```

---

## Security Model

Isolator-V applies five independent security layers. A guest that defeats any single layer still faces the next.

```mermaid
graph LR
    Guest(["Untrusted WASM Guest"])

    L1["Layer 1\nSeccomp BPF\n67 allowed syscalls\n18 kill-on-invoke"]
    L2["Layer 2\nCapability Validator\nOCAP SessionPolicy\n19 WASI caps, default-deny"]
    L3["Layer 3\nVFS Sandbox\nIn-memory only\nNo host paths"]
    L4["Layer 4\nResource Limiter\nMemory grow veto\n+ RSS watchdog"]
    L5["Layer 5\nPII Scrubber\n16 regex patterns\nOutput redaction"]

    Host(["Host OS / Client"])

    Guest --> L1 --> L2 --> L3 --> L4 --> L5 --> Host

    style L1 fill:#c0392b,color:#fff
    style L2 fill:#e67e22,color:#fff
    style L3 fill:#f39c12,color:#000
    style L4 fill:#27ae60,color:#fff
    style L5 fill:#2980b9,color:#fff
```

### Layer Details

| Layer | Mechanism | Scope |
|---|---|---|
| **Seccomp BPF** | Linux kernel syscall whitelist; 67 allowed, 18 kill-on-invoke | Host process |
| **OCAP SessionPolicy** | Default-deny capability set; explicit allowlist per session | WASI call site |
| **VFS Sandbox** | BTreeMap in-memory FS; path traversal rejected; no `preopened` dirs | Guest filesystem |
| **Resource Limiter** | `memory.grow` veto (Wasmtime trait) + RSS watchdog (sysinfo 50ms) | Memory |
| **PII Scrubber** | 16 compiled regex patterns; replaces secrets with `[REDACTED]` | stdout/stderr |

### Denied Syscalls (Seccomp)

The following syscalls kill the host process immediately if invoked:

`execve` · `execveat` · `ptrace` · `mount` · `setuid` · `setgid` · `bpf` · `perf_event_open` · `init_module` · `finit_module` · `delete_module` · `reboot` · `kexec_load` · `userfaultfd` · `pivot_root` · `chroot`

### PII / Secret Patterns Detected

| Category | Patterns |
|---|---|
| API Keys | OpenAI (`sk-…`), Anthropic (`sk-ant-…`), AWS (`AKIA…`), GitHub (`gh[ps]_…`), Google, Stripe, Slack |
| Generic secrets | `api_key=`, `password=`, `access_token=`, `secret_key=`, `database_url=` |
| Tokens | JWT (`eyJ…`), Bearer/Authorization headers |
| Private keys | `-----BEGIN (RSA\|EC\|DSA\|OPENSSH) PRIVATE KEY-----` |
| Connection URIs | `postgres://`, `mysql://`, `redis://`, `mongodb://`, `amqp://`, `mssql://` |
| PII | Email addresses, US SSNs (`XXX-XX-XXXX`), credit card numbers, US phone numbers |

---

## Execution Lifecycle

```mermaid
sequenceDiagram
    participant C as Client
    participant A as Axum Handler
    participant BP as BackPressureGuard
    participant P as SandboxPool
    participant S as WarmSlot (Wasmtime)
    participant V as VFS
    participant SC as PII Scrubber

    C->>A: POST /execute {wasm_b64, label}
    A->>BP: check_admission()
    alt system overloaded
        BP-->>A: Err(LoadSnapshot)
        A-->>C: 503 + Retry-After header
    else admitted
        BP-->>A: Ok(AdmissionTicket)
        A->>A: base64 decode wasm_bytes
        A->>P: execute(wasm_bytes, label)
        P->>P: acquire WarmSlot (Semaphore + VecDeque)
        P->>S: inject wasm → VFS /workspace/main.wasm
        S->>V: path_open / fd_write (intercepted)
        S->>S: run _start (epoch-preempted at 50ms)
        S-->>P: stdout, stderr, exit_code, vfs_snapshot
        P-->>A: ExecutionResult
        A->>SC: scrub(stdout, stderr)
        SC-->>A: sanitised output + ScrubStats
        A-->>C: 200 {job_id, stdout, stderr, vfs_files, elapsed_ms}
        Note over P,S: Slot reset and returned to pool
    end
```

---

## API Reference

### `POST /execute`

Submit a Base64-encoded WASM binary for isolated execution.

**Request:**
```json
{
  "wasm_b64": "<base64-encoded .wasm bytes>",
  "label":    "my-agent-task",
  "session_id": "optional-session-uuid"
}
```

**Response `200`:**
```json
{
  "job_id":     "550e8400-e29b-41d4-a716-446655440000",
  "sandbox_id": "b3a1c2d4-...",
  "exit_code":  0,
  "stdout":     "Hello from WASM!\n",
  "stderr":     "",
  "elapsed_ms": 12,
  "vfs_files":  { "/workspace/output.json": "<base64>" },
  "trap":       null
}
```

**Error responses:**

| Status | Code | Cause |
|---|---|---|
| `400` | `INVALID_PAYLOAD` | Base64 decode failure or invalid WASM |
| `403` | `CAPABILITY_DENIED` | Guest invoked a disallowed WASI capability |
| `408` | `CPU_QUOTA_EXCEEDED` | Guest exceeded 50ms CPU budget |
| `413` | `MEMORY_LIMIT_EXCEEDED` | Guest tried to grow beyond 50 MB |
| `503` | `BACKPRESSURE` | CPU > 80%, Memory > 85%, or Pool > 90% in-use |

---

### `GET /stream/:job_id`

Server-Sent Events stream of real-time stdout. Drains the sandbox ring buffer every 20ms.

```
event: stdout
data: <base64-encoded chunk>
```

---

### `GET /health`

Liveness probe. Returns current warm slot count.

```json
{ "status": "ok", "warm_slots": 47 }
```

---

### `GET /metrics`

Prometheus text exposition format.

```
wasm_pool_warm_slots 47
wasm_backpressure_cpu_percent 23.4
wasm_backpressure_memory_percent 61.2
wasm_backpressure_pool_utilisation 0.060
wasm_backpressure_active_executions 3
wasm_backpressure_shed_total 0
wasm_backpressure_admitted_total 9685
```

---

## Module Breakdown

```mermaid
graph TD
    main["main.rs\n312 LOC\nStartup orchestration\nGraceful shutdown"]

    api["api.rs\n412 LOC\nAxum HTTP handlers\nAppState"]

    pool["sandbox_pool.rs\n1110 LOC\nPool lifecycle\nWASI linker\nEpoch + RSS tasks"]

    vfs["vfs.rs\n700 LOC\nBTreeMap filesystem\nFD table\nRingBuffer"]

    cap["capability.rs\n615 LOC\nOCAP SessionPolicy\nCapabilityValidator\n19 WASI caps"]

    bp["backpressure.rs\n569 LOC\nLoad shedding\nBackground sampler\nRAII ticket"]

    sec["seccomp_guard.rs\n472 LOC\nBPF syscall filter\n67 allowed / 18 denied"]

    pii["pii_scrubber.rs\n430 LOC\n16 regex patterns\nOnceLock compile\nScrubStats"]

    res["resource_monitor.rs\n376 LOC\nRSS watchdog\nSandboxResourceLimiter\nEviction channel"]

    err["error.rs\n134 LOC\nError enum\nis_fatal()"]

    main --> api
    main --> pool
    main --> bp
    main --> sec
    api --> pool
    api --> bp
    api --> pii
    pool --> vfs
    pool --> cap
    pool --> res
    pool --> err

    style pool fill:#2980b9,color:#fff
    style vfs fill:#27ae60,color:#fff
    style cap fill:#e67e22,color:#fff
    style bp fill:#8e44ad,color:#fff
    style sec fill:#c0392b,color:#fff
    style pii fill:#16a085,color:#fff
```

| Module | LOC | Responsibility |
|---|---|---|
| `sandbox_pool.rs` | 1,110 | Pool lifecycle, WASI linker, epoch + RSS background tasks |
| `vfs.rs` | 700 | BTreeMap in-memory filesystem, FD table, ring buffers |
| `capability.rs` | 615 | OCAP `SessionPolicy`, `CapabilityValidator`, 19 WASI caps |
| `backpressure.rs` | 569 | Lock-free load shedding, background CPU sampler, RAII ticket |
| `seccomp_guard.rs` | 472 | BPF syscall filter (67 allowed, 18 kill-on-invoke) |
| `pii_scrubber.rs` | 430 | 16-rule regex redaction pipeline, `OnceLock` compile |
| `api.rs` | 412 | Axum HTTP handlers, `AppState`, SSE bridge |
| `resource_monitor.rs` | 376 | RSS watchdog, `SandboxResourceLimiter`, eviction channel |
| `main.rs` | 312 | Startup orchestration, graceful shutdown |
| `error.rs` | 134 | Error enum, `is_fatal()` classification |
| **Total** | **5,130** | |

---

## Configuration

All tunables live in `PoolConfig` in `main.rs`. No environment variables are exposed to guest code (least-privilege principle).

```rust
let config = PoolConfig {
    pool_size:          50,               // Pre-warmed sandbox slots
    rss_limit_bytes:    50 * 1024 * 1024, // 50 MB RSS hard cap per slot
    memory_limit_bytes: 50 * 1024 * 1024, // 50 MB WASM linear-memory cap
    epoch_tick_ms:      10,               // Epoch interrupt fires every 10ms
    cpu_quota_ticks:    5,                // 5 ticks × 10ms = 50ms CPU budget
};
```

**Back-pressure thresholds** (in `backpressure.rs`):

| Metric | Threshold | Action |
|---|---|---|
| CPU utilisation | > 80% | Shed request → 503 + `Retry-After: 2` |
| CPU utilisation | > 90% | Shed request → 503 + `Retry-After: 5` |
| CPU utilisation | > 95% | Shed request → 503 + `Retry-After: 10` |
| Memory utilisation | > 85% | Shed request → 503 |
| Pool utilisation | > 90% | Shed request → 503 |

**VFS limits** (in `vfs.rs`):

| Limit | Value |
|---|---|
| Write quota | 64 MB per sandbox |
| Max open FDs | 256 per sandbox |
| Stdout ring buffer | 256 KB |
| Stderr ring buffer | 64 KB |

---

## Performance

Benchmark: `hey -n 500 -c 50 POST /execute` with a no-op WASM module.

```
Requests/sec:  9,685
Average:         4.6ms
P50:             3.8ms
P90:            12.2ms
P99:            19.0ms
Slowest:        20.7ms
```

### Latency Distribution

```
  0–2ms  ████████████████████████████  120 reqs
  2–4ms  ████████████████████████████████████████ 180 reqs
  4–6ms  █████████████████████████████  129 reqs
  6–8ms  ████  20 reqs
  8–15ms ███████  31 reqs
 15–21ms █████  19 reqs
```

### Performance Design Decisions

```mermaid
graph LR
    A["Sub-20ms cold start"]
    B["Pooling allocator\npre-reserves VA space\neliminating mmap on hot path"]
    C["50 pre-warmed slots\nStore + Module cached\nno JIT on hot path"]

    D["Lock-free back-pressure\nhot path"]
    E["RwLock read-biased snapshot\n+ AtomicUsize counter\nzero syscalls in check_admission"]

    F["Fair CPU scheduling\nacross 50 sandboxes"]
    G["Epoch-based preemption\n10ms tick × 5 = 50ms quota\nno OS thread starvation"]

    A --> B
    A --> C
    D --> E
    F --> G
```

---

## Tech Stack

### Runtime & Execution
| Crate | Version | Purpose |
|---|---|---|
| `wasmtime` | 25.0 | WASM runtime, Cranelift JIT, pooling allocator, epoch interruption |
| `wasmtime-wasi` | 25.0 | WASI `snapshot_preview1` host implementation |
| `async-trait` | 0.1 | `async fn` in traits (`ResourceLimiterAsync`) |

### Async & Concurrency
| Crate | Version | Purpose |
|---|---|---|
| `tokio` | 1.37 | Async runtime (full features), task scheduling, timers |
| `tokio-stream` | 0.1 | Async streams for SSE bridge |
| `parking_lot` | 0.12 | Faster `Mutex`/`RwLock`, no poisoning overhead |
| `dashmap` | 5.5 | Lock-free concurrent `HashMap` for sandbox registry |

### HTTP & Networking
| Crate | Version | Purpose |
|---|---|---|
| `axum` | 0.7 | HTTP server with WebSocket + macro support |
| `tower` | 0.4 | Middleware abstractions |
| `tower-http` | 0.5 | CORS, distributed tracing layer |

### Serialization & Encoding
| Crate | Version | Purpose |
|---|---|---|
| `serde` + `serde_json` | 1 | JSON API request/response |
| `base64` | 0.22 | WASM payload transport over JSON |

### Security
| Crate | Platform | Purpose |
|---|---|---|
| `libc` | Linux only | seccomp BPF syscall filter bindings |
| `regex` | 1.10 | PII/secret redaction pattern matching |

### Observability & Monitoring
| Crate | Version | Purpose |
|---|---|---|
| `tracing` | 0.1 | Structured, async-aware instrumentation |
| `tracing-subscriber` | 0.3 | JSON log formatting, env-filter |
| `sysinfo` | 0.30 | CPU/memory/RSS per-process probing |

### Error Handling & Utilities
| Crate | Version | Purpose |
|---|---|---|
| `thiserror` | 1.0 | Error enum derive macros |
| `anyhow` | 1.0 | Ergonomic error propagation |
| `uuid` | 1.8 | Unique sandbox/job IDs (v4) |
| `bytes` | 1.6 | Byte buffer abstractions |
| `rand` | 0.8 | Random number generation |

---

## Getting Started

### Prerequisites

- Rust 1.78+ (`rustup update stable`)
- Cargo
- Linux (required for seccomp BPF); macOS supported with seccomp disabled

### Build

```bash
git clone https://github.com/lucastimho/isolator-v
cd isolator-v/wasm-worker-manager

# Development build (opt-level 1, fast compile, debuggable)
cargo build

# Release build (LTO, opt-level 3, panic=abort)
cargo build --release
```

### Run Tests

```bash
# All tests with output
cargo test -- --nocapture

# Specific module
cargo test backpressure -- --nocapture
cargo test pii_scrubber -- --nocapture
```

### Run the Server

```bash
# Default: listens on 0.0.0.0:3000
cargo run --release

# Custom listen address
LISTEN_ADDR=127.0.0.1:8080 cargo run --release

# Log level (default: info)
RUST_LOG=debug cargo run
```

### Send a Test Execution

```bash
# Encode a no-op WASM module
NOOP=$(printf '\x00\x61\x73\x6d\x01\x00\x00\x00\x01\x04\x01\x60\x00\x00\x03\x02\x01\x00\x07\x09\x01\x06\x5f\x73\x74\x61\x72\x74\x00\x00\x0a\x04\x01\x02\x00\x0b' | base64)

curl -s -X POST http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -d "{\"wasm_b64\":\"$NOOP\",\"label\":\"test\"}" | jq .
```

### Benchmark

```bash
# Install hey: https://github.com/rakyll/hey
hey -n 500 -c 50 \
    -m POST \
    -H "Content-Type: application/json" \
    -d "{\"wasm_b64\":\"$NOOP\",\"label\":\"bench\"}" \
    http://localhost:3000/execute
```

---

## Build Profiles

| Profile | `opt-level` | LTO | `panic` | Use case |
|---|---|---|---|---|
| `dev` | 1 | off | unwind | Development, integration tests |
| `release` | 3 | thin | abort | Production — a panicking sandbox host must die immediately |

> **Why `panic=abort` in release?** A panicking host thread must not unwind into adjacent tenants' stacks. The process terminates immediately and a watchdog restarts it.

---

## License

MIT
