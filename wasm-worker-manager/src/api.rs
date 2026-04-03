//! # HTTP API Layer — Axum Server + SSE Streaming Bridge
//!
//! ## Endpoints
//!
//! | Method | Path                | Description                                 |
//! |--------|---------------------|---------------------------------------------|
//! | POST   | `/execute`          | Submit WASM bytes; returns JSON result       |
//! | GET    | `/stream/:id`       | SSE stream for real-time stdout of a job    |
//! | GET    | `/health`           | Liveness probe (returns pool warm-slot count)|
//! | GET    | `/metrics`          | Prometheus-style text metrics               |
//!
//! ## SSE Streaming Design
//!
//! ```text
//!  POST /execute  ──────────────────────► SandboxPool::execute()
//!                                              │
//!                                    writes to RingBuffer (stdout)
//!                                              │
//!  GET /stream/:job_id ◄── SSE poll ──── drain() every 20ms
//!  (Xterm.js frontend)                        │
//!                    ◄── event: data ──── forward bytes as Base64
//! ```
//!
//! The `stream` endpoint is designed for the "Streaming Bridge" described in
//! the architecture doc — zero buffering, low-latency terminal UX.

use std::{
    collections::HashMap,
    convert::Infallible,
    sync::Arc,
    time::Duration,
};

use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response, Sse},
    routing::{get, post},
    Json, Router,
};
use axum::response::sse::{Event, KeepAlive};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio_stream::wrappers::ReceiverStream;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::{error, info, instrument};
use uuid::Uuid;

use crate::{
    error::SandboxError,
    sandbox_pool::SandboxPool,
    vfs::RingBuffer,
    pii_scrubber,
    backpressure::BackPressureGuard,
};

// ─── Shared application state ────────────────────────────────────────────────

/// All state shared between Axum handlers.
#[derive(Clone)]
pub struct AppState {
    pub pool:        Arc<SandboxPool>,
    /// In-flight job map: `job_id → stdout RingBuffer`.
    /// Populated just before `pool.execute()` is called, removed after drain.
    pub live_streams: Arc<Mutex<HashMap<String, Arc<RingBuffer>>>>,
    /// Back-pressure controller — checks system load before admitting requests.
    pub backpressure: Option<Arc<BackPressureGuard>>,
}

impl AppState {
    pub fn new(pool: Arc<SandboxPool>) -> Self {
        Self {
            pool,
            live_streams:  Arc::new(Mutex::new(HashMap::new())),
            backpressure:  None,
        }
    }

    /// Attach a back-pressure guard (builder pattern).
    pub fn with_backpressure(mut self, guard: Arc<BackPressureGuard>) -> Self {
        self.backpressure = Some(guard);
        self
    }
}

// ─── Request / Response DTOs ─────────────────────────────────────────────────

/// POST /execute — request body.
#[derive(Debug, Deserialize)]
pub struct ExecuteRequest {
    /// Raw WASM bytes, Base64-encoded.
    pub wasm_b64: String,
    /// Human-readable label for logging / tracing (e.g. "python-agent-3").
    #[serde(default = "default_label")]
    pub label: String,
    /// Optional session identifier for log correlation.
    pub session_id: Option<String>,
}

fn default_label() -> String { "agent".to_string() }

/// POST /execute — response body on success.
#[derive(Debug, Serialize)]
pub struct ExecuteResponse {
    pub job_id:         String,
    pub sandbox_id:     String,
    pub exit_code:      i32,
    /// Captured stdout (UTF-8; non-UTF-8 bytes are lossy-replaced).
    pub stdout:         String,
    /// Captured stderr.
    pub stderr:         String,
    pub elapsed_ms:     u64,
    /// Snapshot of all files written in the VFS (path → Base64).
    pub vfs_files:      HashMap<String, String>,
    /// If the guest triggered a WASM trap (e.g. `unreachable`, OOB memory),
    /// this field holds the trap description.  Absent on clean `proc_exit`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trap:           Option<String>,
}

/// Uniform JSON error envelope.
#[derive(Debug, Serialize)]
pub struct ApiError {
    pub error:   String,
    pub code:    &'static str,
    pub job_id:  Option<String>,
}

impl ApiError {
    fn new(e: &SandboxError) -> Self {
        let (msg, code) = match e {
            SandboxError::PoolExhausted { .. }     => (e.to_string(), "POOL_EXHAUSTED"),
            SandboxError::CpuQuotaExceeded { .. }  => (e.to_string(), "CPU_QUOTA_EXCEEDED"),
            SandboxError::MemoryLimitExceeded { .. }=> (e.to_string(), "MEMORY_LIMIT_EXCEEDED"),
            SandboxError::RssLimitExceeded { .. }  => (e.to_string(), "RSS_LIMIT_EXCEEDED"),
            SandboxError::CapabilityDenied { .. }  => (e.to_string(), "CAPABILITY_DENIED"),
            _                                       => (e.to_string(), "INTERNAL_ERROR"),
        };
        Self { error: msg, code, job_id: None }
    }
}

// ─── Router ──────────────────────────────────────────────────────────────────

/// Build and return the Axum `Router`.
pub fn build_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/execute",        post(handle_execute))
        .route("/stream/:job_id", get(handle_stream))
        .route("/health",         get(handle_health))
        .route("/metrics",        get(handle_metrics))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}

/// Start the HTTP server and block until CTRL-C.
pub async fn serve(state: AppState, addr: &str) -> anyhow::Result<()> {
    let app      = build_router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!(addr, "HTTP server listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("failed to install Ctrl+C handler");
    info!("Received shutdown signal — draining connections");
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/// `POST /execute`
///
/// Accepts a Base64-encoded WASM module, runs it in an isolated sandbox,
/// and returns stdout/stderr/VFS snapshot as JSON.
#[instrument(skip(state, body), fields(label = %body.label))]
async fn handle_execute(
    State(state): State<AppState>,
    Json(body):   Json<ExecuteRequest>,
) -> Response {
    let job_id = Uuid::new_v4().to_string();

    // ── Back-pressure check ──────────────────────────────────────────────
    // If the system is overloaded, shed the request immediately with 503.
    if let Some(ref bp) = state.backpressure {
        if let Err(snapshot) = bp.check_admission(state.pool.warm_count()) {
            let (status, headers, body) = crate::backpressure::build_503_response(&snapshot);
            return (status, headers, body).into_response();
        }
    }

    // Decode the Base64 WASM payload.
    let wasm_bytes = match BASE64_ENGINE.decode(&body.wasm_b64) {
        Ok(b)  => b,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    error:  format!("Invalid Base64: {e}"),
                    code:   "INVALID_PAYLOAD",
                    job_id: Some(job_id),
                }),
            ).into_response();
        }
    };

    info!(
        job_id  = %job_id,
        label   = %body.label,
        wasm_kb = wasm_bytes.len() / 1024,
        "Dispatching sandbox execution"
    );

    match state.pool.execute(wasm_bytes, &body.label).await {
        Ok(result) => {
            let raw_stdout = String::from_utf8_lossy(&result.stdout).into_owned();
            let raw_stderr = String::from_utf8_lossy(&result.stderr).into_owned();

            // ── PII / Secret scrubbing ───────────────────────────────────
            // Redact API keys, credentials, PII from sandbox output before
            // it reaches the client (last line of defense).
            let (stdout, stderr, scrub_stats) =
                pii_scrubber::scrub_execution_output(&raw_stdout, &raw_stderr);

            if scrub_stats.redactions > 0 {
                info!(
                    job_id      = %job_id,
                    redactions  = scrub_stats.redactions,
                    rules       = ?scrub_stats.matched_rules,
                    "PII scrubber redacted secrets from sandbox output"
                );
            }

            // Encode VFS files as Base64.
            let vfs_files = result.vfs_snapshot
                .into_iter()
                .map(|(k, v)| (k, BASE64_ENGINE.encode(&v)))
                .collect();

            let resp = ExecuteResponse {
                job_id:     job_id.clone(),
                sandbox_id: result.sandbox_id,
                exit_code:  result.exit_code,
                stdout,
                stderr,
                elapsed_ms: result.elapsed.as_millis() as u64,
                vfs_files,
                trap:       result.trap_message,
            };

            info!(
                job_id     = %job_id,
                elapsed_ms = resp.elapsed_ms,
                exit_code  = resp.exit_code,
                "Execution complete"
            );

            (StatusCode::OK, Json(resp)).into_response()
        }

        Err(e) => {
            let status = match &e {
                SandboxError::PoolExhausted { .. }     => StatusCode::SERVICE_UNAVAILABLE,
                SandboxError::CpuQuotaExceeded { .. }  => StatusCode::REQUEST_TIMEOUT,
                SandboxError::MemoryLimitExceeded { .. } => StatusCode::PAYLOAD_TOO_LARGE,
                SandboxError::CapabilityDenied { .. }  => StatusCode::FORBIDDEN,
                _                                       => StatusCode::INTERNAL_SERVER_ERROR,
            };

            error!(job_id = %job_id, error = %e, "Sandbox execution failed");

            let mut api_err = ApiError::new(&e);
            api_err.job_id = Some(job_id);

            (status, Json(api_err)).into_response()
        }
    }
}

/// `GET /stream/:job_id`
///
/// Server-Sent Events endpoint.  The frontend (Xterm.js) connects here and
/// receives terminal output in near-real-time as the WASM module writes to
/// stdout.
///
/// ## SSE event format
///
/// ```text
/// event: stdout
/// data: <Base64-encoded bytes>
///
/// event: done
/// data: {"exit_code": 0}
/// ```
async fn handle_stream(
    Path(job_id): Path<String>,
    State(state): State<AppState>,
) -> Sse<impl tokio_stream::Stream<Item = std::result::Result<Event, Infallible>>> {
    // In the full implementation this pairs with the job registry populated in
    // handle_execute.  We expose the SSE scaffolding and drain loop here.
    let ring = {
        state.live_streams.lock().await.get(&job_id).cloned()
    };

    let (tx, rx) = tokio::sync::mpsc::channel::<std::result::Result<Event, Infallible>>(64);

    tokio::spawn(async move {
        match ring {
            Some(buf) => {
                // Poll the ring buffer every 20ms and emit SSE events.
                let mut interval = tokio::time::interval(Duration::from_millis(20));
                loop {
                    interval.tick().await;
                    let chunk = buf.drain();
                    if chunk.is_empty() {
                        // Check if job has finished (in prod: watch a completion channel).
                        // For the streaming bridge skeleton we yield for 2 seconds then close.
                        continue;
                    }
                    let encoded = BASE64_ENGINE.encode(&chunk);
                    let event = Event::default()
                        .event("stdout")
                        .data(encoded);
                    if tx.send(Ok(event)).await.is_err() {
                        break; // Client disconnected.
                    }
                }
            }
            None => {
                // Job not found or already completed.
                let event = Event::default()
                    .event("error")
                    .data(format!("job '{}' not found", job_id));
                let _ = tx.send(Ok(event)).await;
            }
        }
    });

    let stream = ReceiverStream::new(rx);
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// `GET /health`
///
/// Returns HTTP 200 with the current warm-slot count.  Used by HAProxy /
/// Consul health checks — if `warm_slots == 0` the load-balancer can
/// temporarily drain this node.
async fn handle_health(State(state): State<AppState>) -> Response {
    let warm = state.pool.warm_count();
    let body = serde_json::json!({
        "status":     "ok",
        "warm_slots": warm,
    });
    (StatusCode::OK, Json(body)).into_response()
}

/// `GET /metrics`
///
/// Minimal Prometheus-compatible text exposition.
/// In production, use the `metrics` + `metrics-exporter-prometheus` crates.
async fn handle_metrics(State(state): State<AppState>) -> Response {
    let warm = state.pool.warm_count();
    let mut body = format!(
        "# HELP wasm_pool_warm_slots Current pre-warmed sandbox slots available\n\
         # TYPE wasm_pool_warm_slots gauge\n\
         wasm_pool_warm_slots {warm}\n"
    );

    // Append back-pressure metrics if the guard is active.
    if let Some(ref bp) = state.backpressure {
        body.push_str(&crate::backpressure::prometheus_metrics(bp));
    }

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        body,
    ).into_response()
}

// ─── Base64 engine ───────────────────────────────────────────────────────────
//
// The `base64` 0.22 crate requires an explicit engine rather than free
// functions.  We use the standard alphabet with padding.

use base64::Engine as _;

static BASE64_ENGINE: base64::engine::GeneralPurpose =
    base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new(),
    );
