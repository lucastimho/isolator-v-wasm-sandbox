package worker

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"go.uber.org/zap"
)

// HTTPWorkerClient implements Client by calling the existing Rust
// wasm-worker-manager REST API.  This adapter lets the orchestrator work today
// without any changes to the Rust binary; swap it for GRPCWorkerClient later.
type HTTPWorkerClient struct {
	addr       string
	httpClient *http.Client
	log        *zap.Logger
}

// NewHTTPClient constructs a pooled HTTP client pointed at the given worker address.
// addr should be scheme+host only, e.g. "http://localhost:3000".
func NewHTTPClient(addr string) *HTTPWorkerClient {
	return &HTTPWorkerClient{
		addr: addr,
		log:  zap.NewNop(), // replaced by NewHTTPClientWithLogger in production
		httpClient: &http.Client{
			// Outer timeout is controlled by the caller's context; this is a
			// safety net only.
			Timeout: 60 * time.Second,
			Transport: &http.Transport{
				MaxIdleConnsPerHost:   64,
				IdleConnTimeout:       90 * time.Second,
				ResponseHeaderTimeout: 35 * time.Second,
			},
		},
	}
}

// NewHTTPClientWithLogger constructs a client that emits debug-level traces.
// Use this instead of NewHTTPClient when a logger is available (e.g. in main).
func NewHTTPClientWithLogger(addr string, log *zap.Logger) *HTTPWorkerClient {
	c := NewHTTPClient(addr)
	c.log = log
	return c
}

// ── Execute ───────────────────────────────────────────────────────────────────

// rustExecuteReq matches the Rust worker's POST /execute body.
type rustExecuteReq struct {
	WASMB64   string `json:"wasm_b64"`
	Label     string `json:"label"`
	TimeoutMs uint64 `json:"timeout_ms,omitempty"` // 0 → worker default
}

// rustExecuteResp matches the Rust worker's 200 response.
//
// NOTE on field types:
//   - Stdout/Stderr: Rust serialises these as plain UTF-8 JSON strings (via
//     String::from_utf8_lossy).  Go's json.Decoder would base64-decode a
//     []byte field, so we use string here and convert to []byte manually.
//   - VFSSnapshot: Rust serialises the map values as base64 strings (via
//     BASE64_ENGINE.encode) under the key "vfs_files".  []byte fields are
//     auto-base64-decoded by Go's json.Decoder, which is exactly what we want.
type rustExecuteResp struct {
	SandboxID   string            `json:"sandbox_id"`
	Stdout      string            `json:"stdout"`    // plain UTF-8 string from Rust
	Stderr      string            `json:"stderr"`    // plain UTF-8 string from Rust
	ExitCode    int32             `json:"exit_code"`
	ElapsedMS   uint64            `json:"elapsed_ms"`
	VFSSnapshot map[string][]byte `json:"vfs_files"` // Rust field name is "vfs_files"; values are base64
	// Non-nil when the guest trapped (e.g. unreachable, OOB memory access).
	Trap *string `json:"trap,omitempty"`
	// Error fields (4xx/5xx)
	Error string `json:"error"`
	Code  string `json:"code"`
}

func (c *HTTPWorkerClient) Execute(ctx context.Context, req *ExecuteRequest) (*ExecuteResponse, error) {
	body := rustExecuteReq{
		WASMB64: base64.StdEncoding.EncodeToString(req.WASMBytes),
		Label:   req.Label,
	}
	if req.Timeout > 0 {
		body.TimeoutMs = uint64(req.Timeout.Milliseconds())
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("worker/http marshal: %w", err)
	}

	c.log.Debug("[http-worker] sending POST /execute to worker",
		zap.String("addr", c.addr),
		zap.String("label", req.Label),
		zap.Int("body_bytes", len(data)),
	)
	t0 := time.Now()

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.addr+"/execute", bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("worker/http build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		c.log.Debug("[http-worker] POST /execute network error",
			zap.String("addr", c.addr),
			zap.Duration("elapsed", time.Since(t0)),
			zap.Error(err),
		)
		return nil, fmt.Errorf("worker/http do: %w", err)
	}
	defer resp.Body.Close()

	c.log.Debug("[http-worker] POST /execute response received",
		zap.String("addr", c.addr),
		zap.Int("status", resp.StatusCode),
		zap.Duration("elapsed", time.Since(t0)),
	)

	var result rustExecuteResp
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("worker/http decode [%d]: %w", resp.StatusCode, err)
	}

	c.log.Debug("[http-worker] response decoded",
		zap.String("addr", c.addr),
		zap.String("sandbox_id", result.SandboxID),
		zap.Int32("exit_code", result.ExitCode),
		zap.Uint64("worker_elapsed_ms", result.ElapsedMS),
		zap.Int("stdout_bytes", len(result.Stdout)),
		zap.Int("stderr_bytes", len(result.Stderr)),
	)

	if resp.StatusCode >= 400 || result.Error != "" {
		return nil, fmt.Errorf("worker error %d (%s): %s", resp.StatusCode, result.Code, result.Error)
	}

	return &ExecuteResponse{
		SandboxID:   result.SandboxID,
		SessionID:   req.SessionID,        // carry through for VFS persistence
		Stdout:      []byte(result.Stdout), // convert UTF-8 string → raw bytes for WS streaming
		Stderr:      []byte(result.Stderr),
		ExitCode:    result.ExitCode,
		ElapsedMS:   result.ElapsedMS,
		VFSSnapshot: result.VFSSnapshot,   // map[string][]byte, auto-decoded from base64 by json.Decoder
		TrapMessage: result.Trap,
	}, nil
}

// ── Health ────────────────────────────────────────────────────────────────────

type rustHealthResp struct {
	Status    string `json:"status"`
	WarmSlots int    `json:"warm_slots"`
}

func (c *HTTPWorkerClient) Health(ctx context.Context) (*HealthStatus, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.addr+"/health", nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return &HealthStatus{Healthy: false, Addr: c.addr}, err
	}
	defer resp.Body.Close()

	var h rustHealthResp
	if err := json.NewDecoder(resp.Body).Decode(&h); err != nil {
		return nil, err
	}

	return &HealthStatus{
		Healthy:   resp.StatusCode == http.StatusOK,
		WarmSlots: h.WarmSlots,
		Addr:      c.addr,
	}, nil
}

func (c *HTTPWorkerClient) Addr() string { return c.addr }
func (c *HTTPWorkerClient) Close() error { return nil }
