package worker

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// HTTPWorkerClient implements Client by calling the existing Rust
// wasm-worker-manager REST API.  This adapter lets the orchestrator work today
// without any changes to the Rust binary; swap it for GRPCWorkerClient later.
type HTTPWorkerClient struct {
	addr       string
	httpClient *http.Client
}

// NewHTTPClient constructs a pooled HTTP client pointed at the given worker address.
// addr should be scheme+host only, e.g. "http://localhost:3000".
func NewHTTPClient(addr string) *HTTPWorkerClient {
	return &HTTPWorkerClient{
		addr: addr,
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

// ── Execute ───────────────────────────────────────────────────────────────────

// rustExecuteReq matches the Rust worker's POST /execute body.
type rustExecuteReq struct {
	WASMB64   string `json:"wasm_b64"`
	Label     string `json:"label"`
	TimeoutMs uint64 `json:"timeout_ms,omitempty"` // 0 → worker default
}

// rustExecuteResp matches the Rust worker's 200 response.
type rustExecuteResp struct {
	SandboxID   string            `json:"sandbox_id"`
	Stdout      []byte            `json:"stdout"`
	Stderr      []byte            `json:"stderr"`
	ExitCode    int32             `json:"exit_code"`
	ElapsedMS   uint64            `json:"elapsed_ms"`
	VFSSnapshot map[string][]byte `json:"vfs_snapshot"`
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

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.addr+"/execute", bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("worker/http build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("worker/http do: %w", err)
	}
	defer resp.Body.Close()

	var result rustExecuteResp
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("worker/http decode [%d]: %w", resp.StatusCode, err)
	}

	if resp.StatusCode >= 400 || result.Error != "" {
		return nil, fmt.Errorf("worker error %d (%s): %s", resp.StatusCode, result.Code, result.Error)
	}

	return &ExecuteResponse{
		SandboxID:   result.SandboxID,
		SessionID:   req.SessionID, // carry through for VFS persistence
		Stdout:      result.Stdout,
		Stderr:      result.Stderr,
		ExitCode:    result.ExitCode,
		ElapsedMS:   result.ElapsedMS,
		VFSSnapshot: result.VFSSnapshot,
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
