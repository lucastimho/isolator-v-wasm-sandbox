# Testing Guide — WASM Worker Manager

This guide walks you through every layer of testing: unit, integration,
API smoke tests, security validation, and performance baselines.

---

## Prerequisites

```bash
# 1. Install Rust (stable toolchain, 1.79+)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup update stable

# 2. (Optional) Install wat2wasm to compile the .wat fixture files
#    macOS:
brew install wabt
#    Ubuntu/Debian:
sudo apt-get install -y wabt
#    Or use the online tool: https://webassembly.github.io/wabt/demo/wat2wasm/

# 3. (Optional) jq for pretty-printing JSON from curl tests
brew install jq        # macOS
sudo apt-get install jq # Linux
```

---

## Step 1 — Compile the Project

```bash
cd wasm-worker-manager

# Dev build (fast, includes debug symbols)
cargo build

# Release build (Cranelift optimisations, LTO)
cargo build --release
```

Expected output: the compiler resolves all crates (~2–3 minutes on first build due to Wasmtime + Cranelift). Subsequent builds are incremental and take seconds.

---

## Step 2 — Unit Tests (`cargo test`)

The unit tests live inline in each module (`#[cfg(test)]`). Run them all:

```bash
cargo test -- --nocapture
```

### Run only a specific module's tests

```bash
cargo test vfs            # VFS tests: path canonicalisation, read/write, ring buffer
cargo test resource       # ResourceLimiter + ResourceMonitor tests
cargo test pool           # SandboxPool unit tests
```

### What to look for

| Test | Expected |
|---|---|
| `canonicalise_rejects_traversal` | PASS — `/../etc/passwd` is denied |
| `write_quota_enforced` | PASS — writes past 64 MB cap return `Err` |
| `ring_buffer_drains` | PASS — drain is idempotent |
| `resource_limiter_blocks_oversized_growth` | PASS — 51 MB denied for 50 MB cap |
| `pool_initialises_with_warm_slots` | PASS — pool_size=3 → 3 warm slots |
| `noop_stub_executes_cleanly` | PASS — exit_code=0, stdout empty |

---

## Step 3 — Integration Tests

Integration tests live in `tests/integration_test.rs`. They use the `wat` crate to compile WebAssembly Text Format inline, which means **no external tools needed**.

```bash
cargo test --test integration_test -- --nocapture
```

### Test matrix

| Test | What it validates |
|---|---|
| `vfs_tests::canon_rejects_dotdot_traversal` | Path traversal blocked at VFS layer |
| `vfs_tests::create_and_read_back_file` | Full write → seek → read round-trip |
| `vfs_tests::o_excl_rejects_existing_file` | O_EXCL semantics |
| `vfs_tests::fdflags_append_writes_at_end` | APPEND mode writes to file end |
| `vfs_tests::ring_buffer_evicts_oldest_bytes_when_full` | Ring buffer overflow behaviour |
| `pool_tests::noop_stub_exits_zero` | Warm-start latency <20ms |
| `pool_tests::concurrent_executions_all_succeed` | 10 parallel sandboxes all succeed |
| `pool_tests::stdout_writer_wasm_output_captured` | stdout ring buffer captured correctly |
| **`pool_tests::cpu_quota_exceeded_returns_error`** | Epoch interruption fires, returns `CpuQuotaExceeded` |
| **`pool_tests::memory_growth_beyond_cap_is_denied`** | `memory.grow` past 50 MB returns -1 to guest |
| **`pool_tests::guest_can_write_file_via_vfs`** | Full VFS write from guest, visible in vfs_snapshot |
| **`pool_tests::environ_is_always_empty`** | Zero env vars leaked to guest (Least Privilege) |

Run a single integration test:

```bash
cargo test --test integration_test cpu_quota -- --nocapture
cargo test --test integration_test environ    -- --nocapture
cargo test --test integration_test traversal  -- --nocapture
```

---

## Step 4 — Start the Server

```bash
# Dev server (hot-recompile with cargo-watch if you have it)
cargo run

# Or release build for accurate latency measurements
cargo run --release

# Custom listen address
LISTEN_ADDR=0.0.0.0:8080 cargo run --release
```

You should see JSON structured logs like:

```json
{"level":"INFO","fields":{"message":"WASM Worker Manager starting","version":"0.1.0","pool_size":50,"memory_limit":"50MB"}}
{"level":"INFO","fields":{"message":"Pool initialised — starting HTTP server","warm_slots":50}}
{"level":"INFO","fields":{"message":"HTTP server listening","addr":"0.0.0.0:3000"}}
```

---

## Step 5 — API Smoke Tests

With the server running in another terminal:

```bash
chmod +x scripts/test_api.sh
./scripts/test_api.sh
# Or against a different address:
./scripts/test_api.sh http://localhost:8080
```

Expected output:

```
══ §1  Liveness ══
  ✔ PASS  /health returned 200 (warm_slots=50)
  ✔ PASS  /metrics returned Prometheus format

══ §2  Execute — happy path ══
  ✔ PASS  /execute (no-op) returned 200 (exit_code=0, elapsed_ms=3ms)
  ✔ PASS  Cold/warm start latency 3ms ≤ 500ms

══ §3  Execute — error handling ══
  ✔ PASS  /execute with invalid Base64 returns 400
  ...

══ §6  Summary ══
  Results: 12 passed / 0 failed / 12 total
  All tests passed! 🎉
```

---

## Step 6 — Manual curl Testing

### 6a. Health check
```bash
curl http://localhost:3000/health | jq .
# {"status":"ok","warm_slots":50}
```

### 6b. Execute the no-op WASM module

The server accepts Base64-encoded WASM. The minimal no-op module:

```bash
# This is (module (func (export "_start"))) in binary, Base64-encoded
NOOP="AGFzbQEAAAABBAFgAAADAgEABwoBBl9zdGFydAAACgQBAgAL"

curl -s http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -d "{\"wasm_b64\":\"$NOOP\",\"label\":\"my-test\"}" | jq .
```

Expected response:
```json
{
  "job_id": "...",
  "sandbox_id": "...",
  "exit_code": 0,
  "stdout": "",
  "stderr": "",
  "elapsed_ms": 3,
  "vfs_files": {}
}
```

### 6c. Compile and execute a real WAT fixture

```bash
# Requires wat2wasm (from wabt)
wat2wasm fixtures/hello.wat -o /tmp/hello.wasm

WASM_B64=$(base64 -i /tmp/hello.wasm | tr -d '\n')

curl -s http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -d "{\"wasm_b64\":\"$WASM_B64\",\"label\":\"hello-fixture\"}" | jq .
```

Expected:
```json
{
  "stdout": "Hello from WASM sandbox!\n",
  "exit_code": 0,
  "vfs_files": {
    "/workspace/result.json": "<base64 of {\"status\":\"ok\",\"sandbox\":true}>"
  }
}
```

### 6d. CPU quota test (should timeout)

```bash
wat2wasm fixtures/infinite_loop.wat -o /tmp/loop.wasm
WASM_B64=$(base64 -i /tmp/loop.wasm | tr -d '\n')

curl -s http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -d "{\"wasm_b64\":\"$WASM_B64\",\"label\":\"infinite-loop\"}" | jq .
# HTTP 408 — {"error":"CPU quota exceeded: sandbox ran longer than 50ms","code":"CPU_QUOTA_EXCEEDED"}
```

### 6e. Memory cap test

```bash
wat2wasm fixtures/memory_hog.wat -o /tmp/memhog.wasm
WASM_B64=$(base64 -i /tmp/memhog.wasm | tr -d '\n')

curl -s http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -d "{\"wasm_b64\":\"$WASM_B64\",\"label\":\"memory-hog\"}" | jq .
# stdout: "denied"  exit_code: 0  (guest handled the failed grow gracefully)
```

### 6f. Path traversal security test

```bash
wat2wasm fixtures/path_traversal.wat -o /tmp/traversal.wasm
WASM_B64=$(base64 -i /tmp/traversal.wasm | tr -d '\n')

curl -s http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -d "{\"wasm_b64\":\"$WASM_B64\",\"label\":\"traversal-attempt\"}" | jq .
# stdout: "BLOCKED"  — traversal was denied at the VFS layer
```

### 6g. SSE streaming
```bash
# Open an SSE connection (streams until Ctrl-C or timeout)
curl -s -N \
  -H "Accept: text/event-stream" \
  http://localhost:3000/stream/some-job-id
# event: error
# data: job 'some-job-id' not found
```

### 6h. Prometheus metrics
```bash
curl http://localhost:3000/metrics
# # HELP wasm_pool_warm_slots Current pre-warmed sandbox slots available
# # TYPE wasm_pool_warm_slots gauge
# wasm_pool_warm_slots 48
```

---

## Step 7 — Performance Baseline

Measure warm-start latency with `hey` or `wrk`:

```bash
# Install hey (Go HTTP benchmarker)
go install github.com/rakyll/hey@latest

NOOP="AGFzbQEAAAABBAFgAAADAgEABwkBBl9zdGFydAAACgQBAgAL"

# 500 requests, 50 concurrent — matches the "500+ sandboxes per node" spec
hey -n 500 -c 50 \
    -m POST \
    -H "Content-Type: application/json" \
    -d "{\"wasm_b64\":\"$NOOP\",\"label\":\"bench\"}" \
    http://localhost:3000/execute
```

Expected baseline (warm pool, release build):
```
Summary:
  Total:        0.4s
  Slowest:      0.018s   ← sub-20ms ✔
  Fastest:      0.001s
  Average:      0.004s
  Requests/sec: 1250+
```

If p99 latency is >20ms, check:
- Is the server running in `--release` mode?
- Is the warm pool exhausted? (Check `/metrics`)
- Are you on a shared CI runner with throttled CPU?

---

## Step 8 — Log Analysis

The server emits structured JSON logs. Use `jq` to filter:

```bash
# Only errors
cargo run 2>&1 | jq -R 'try fromjson | select(.level=="ERROR")'

# Pool/execution events only
cargo run 2>&1 | jq -R 'try fromjson | select(.fields.message | test("sandbox|pool|VFS"))'

# Resource monitor kills
cargo run 2>&1 | jq -R 'try fromjson | select(.fields.message | test("RSS|eviction|killed"))'
```

---

## Step 9 — Running in CI (GitHub Actions example)

```yaml
# .github/workflows/test.yml
name: CI
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
      - name: Unit + integration tests
        run: cargo test --all -- --nocapture
      - name: Release build
        run: cargo build --release
      - name: Start server + smoke tests
        run: |
          ./target/release/wasm-worker-manager &
          SERVER_PID=$!
          sleep 3   # wait for pre-warm
          ./scripts/test_api.sh
          kill $SERVER_PID
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `error[E0412]: cannot find type 'SandboxPool'` | `lib.rs` not compiled | Run `cargo build` first; check `[lib]` in Cargo.toml |
| `thread 'main' panicked: Pool initialised with 0 slots` | Engine config error | Check `RUST_LOG=debug cargo run` for details |
| `/execute` returns 503 immediately | Pool exhausted | Increase `pool_size` in `PoolConfig` |
| CPU quota test doesn't timeout | Epoch ticker not running | Ensure `spawn_epoch_ticker` is called in `SandboxPool::new` |
| `wat2wasm: command not found` | wabt not installed | Run integration tests via `cargo test` — they use the `wat` crate directly |
| `jq: command not found` | jq not installed | Replace `| jq .` with `| python3 -m json.tool` |
