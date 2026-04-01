// Package api implements the orchestrator's HTTP layer.
package api

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"time"

	"go.uber.org/zap"

	"github.com/lucasho/isolator-v/orchestrator/internal/pool"
	"github.com/lucasho/isolator-v/orchestrator/internal/worker"
)

// Handler holds the dependencies injected into every HTTP handler.
type Handler struct {
	manager *pool.Manager
	log     *zap.Logger
}

// NewHandler constructs a Handler.
func NewHandler(manager *pool.Manager, log *zap.Logger) *Handler {
	return &Handler{manager: manager, log: log}
}

// ── POST /execute ─────────────────────────────────────────────────────────────

type executeReq struct {
	// WASMB64 is the raw WASM binary encoded as standard Base64.
	WASMB64   string `json:"wasm_b64"`
	Label     string `json:"label"`
	SessionID string `json:"session_id"`
	// TimeoutMS overrides the default execution timeout.  0 → server default.
	TimeoutMS uint64 `json:"timeout_ms"`
}

type executeResp struct {
	SandboxID   string            `json:"sandbox_id"`
	Stdout      []byte            `json:"stdout"`
	Stderr      []byte            `json:"stderr"`
	ExitCode    int32             `json:"exit_code"`
	ElapsedMS   uint64            `json:"elapsed_ms"`
	WorkerAddr  string            `json:"worker_addr"`
	VFSSnapshot map[string][]byte `json:"vfs_snapshot,omitempty"`
}

func (h *Handler) Execute(w http.ResponseWriter, r *http.Request) {
	var req executeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	if req.WASMB64 == "" {
		jsonError(w, "wasm_b64 is required", http.StatusBadRequest)
		return
	}

	wasmBytes, err := base64.StdEncoding.DecodeString(req.WASMB64)
	if err != nil {
		jsonError(w, "invalid wasm_b64 (not valid Base64): "+err.Error(), http.StatusBadRequest)
		return
	}

	// Validate it looks like a WASM binary (\0asm magic + version).
	if len(wasmBytes) < 8 ||
		wasmBytes[0] != 0x00 || wasmBytes[1] != 0x61 ||
		wasmBytes[2] != 0x73 || wasmBytes[3] != 0x6d {
		jsonError(w, "invalid WASM binary: missing magic bytes", http.StatusBadRequest)
		return
	}

	timeout := time.Duration(req.TimeoutMS) * time.Millisecond
	if timeout == 0 {
		timeout = 30 * time.Second
	}

	result, err := h.manager.Execute(r.Context(), &worker.ExecuteRequest{
		WASMBytes: wasmBytes,
		Label:     req.Label,
		SessionID: req.SessionID,
		Timeout:   timeout,
	})
	if err != nil {
		h.log.Error("execute failed",
			zap.String("label", req.Label),
			zap.Error(err),
		)
		jsonError(w, "execution failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	jsonOK(w, executeResp{
		SandboxID:   result.SandboxID,
		Stdout:      result.Stdout,
		Stderr:      result.Stderr,
		ExitCode:    result.ExitCode,
		ElapsedMS:   result.TotalMS,
		WorkerAddr:  result.WorkerAddr,
		VFSSnapshot: result.VFSSnapshot,
	})
}

// ── GET /health ───────────────────────────────────────────────────────────────

func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	stats := h.manager.Stats()
	jsonOK(w, map[string]any{
		"status": "ok",
		"ts":     time.Now().UTC().Format(time.RFC3339),
		"pool":   stats,
	})
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func jsonOK(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	//nolint:errcheck
	json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	//nolint:errcheck
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
