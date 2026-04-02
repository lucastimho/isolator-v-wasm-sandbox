// Package api implements the orchestrator's HTTP layer.
package api

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	chi "github.com/go-chi/chi/v5"
	"go.uber.org/zap"
	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"

	"github.com/lucasho/isolator-v/orchestrator/internal/pool"
	vfspkg "github.com/lucasho/isolator-v/orchestrator/internal/vfs"
	"github.com/lucasho/isolator-v/orchestrator/internal/worker"
)

// VFSStore is the minimal read interface the API needs from the VFS package.
type VFSStore interface {
	QueryEntries(ctx context.Context, sessionID string) ([]vfspkg.FileEntry, error)
	QueryFile(ctx context.Context, sessionID, path string) ([]byte, error)
}

// Handler holds the dependencies injected into every HTTP handler.
type Handler struct {
	manager *pool.Manager
	vfs     VFSStore // nil when VFS persistence is disabled
	log     *zap.Logger
}

// NewHandler constructs a Handler.
func NewHandler(manager *pool.Manager, vfs VFSStore, log *zap.Logger) *Handler {
	return &Handler{manager: manager, vfs: vfs, log: log}
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

// ── GET /vitals/{sessionId} ───────────────────────────────────────────────────

// vitalsResp is the JSON shape returned to the frontend AgentVitals component.
type vitalsResp struct {
	MemUsedBytes  int64   `json:"mem_used_bytes"`
	MemLimitBytes int64   `json:"mem_limit_bytes"`
	CPUPct        float64 `json:"cpu_pct"`
	PoolActive    int     `json:"pool_active"`
	PoolCapacity  int     `json:"pool_capacity"`
}

const memLimitBytes int64 = 50 * 1024 * 1024 // 50 MB matches frontend constant

func (h *Handler) Vitals(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")

	stats    := h.manager.Stats()
	warmSlots, _ := stats["warm_slots"].(int)
	poolCap,  _ := stats["pool_cap"].(int)
	// "active" workers = capacity minus those waiting in the warm pool.
	active   := poolCap - warmSlots
	if active < 0 {
		active = 0
	}

	// Compute memory proxy: sum of VFS snapshot sizes for this session.
	var memUsed int64
	if h.vfs != nil && sessionID != "" {
		entries, err := h.vfs.QueryEntries(r.Context(), sessionID)
		if err != nil {
			h.log.Warn("vitals: vfs query failed", zap.String("session", sessionID), zap.Error(err))
		}
		for _, e := range entries {
			memUsed += e.Size
		}
	}

	// CPU proxy: fraction of pool workers currently executing.
	var cpuPct float64
	if poolCap > 0 {
		cpuPct = float64(active) / float64(poolCap) * 100
	}

	jsonOK(w, vitalsResp{
		MemUsedBytes:  memUsed,
		MemLimitBytes: memLimitBytes,
		CPUPct:        cpuPct,
		PoolActive:    active,
		PoolCapacity:  poolCap,
	})
}

// ── GET /vfs/{sessionId} ─────────────────────────────────────────────────────

type vfsListEntry struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

func (h *Handler) VFSList(w http.ResponseWriter, r *http.Request) {
	if h.vfs == nil {
		jsonError(w, "vfs persistence disabled", http.StatusServiceUnavailable)
		return
	}
	sessionID := chi.URLParam(r, "sessionId")
	entries, err := h.vfs.QueryEntries(r.Context(), sessionID)
	if err != nil {
		h.log.Error("vfs list failed", zap.String("session", sessionID), zap.Error(err))
		jsonError(w, fmt.Sprintf("vfs list: %s", err), http.StatusInternalServerError)
		return
	}

	out := make([]vfsListEntry, len(entries))
	for i, e := range entries {
		out[i] = vfsListEntry{Path: e.Path, Size: e.Size}
	}
	jsonOK(w, out)
}

// ── GET /vfs/{sessionId}/file?path= ──────────────────────────────────────────

func (h *Handler) VFSFile(w http.ResponseWriter, r *http.Request) {
	if h.vfs == nil {
		jsonError(w, "vfs persistence disabled", http.StatusServiceUnavailable)
		return
	}
	sessionID := chi.URLParam(r, "sessionId")
	path := r.URL.Query().Get("path")
	if path == "" {
		jsonError(w, "path query parameter is required", http.StatusBadRequest)
		return
	}

	data, err := h.vfs.QueryFile(r.Context(), sessionID, path)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			jsonError(w, "file not found", http.StatusNotFound)
			return
		}
		h.log.Error("vfs file fetch failed",
			zap.String("session", sessionID),
			zap.String("path", path),
			zap.Error(err),
		)
		jsonError(w, fmt.Sprintf("vfs file: %s", err), http.StatusInternalServerError)
		return
	}

	// Serve with a sensible Content-Type based on extension.
	ct := contentTypeFor(path)
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// contentTypeFor maps common VFS path extensions to MIME types.
func contentTypeFor(path string) string {
	switch {
	case hasSuffix(path, ".json", ".plot"):
		return "application/json"
	case hasSuffix(path, ".csv"):
		return "text/csv; charset=utf-8"
	case hasSuffix(path, ".wasm"):
		return "application/wasm"
	case hasSuffix(path, ".txt", ".log", ".md"):
		return "text/plain; charset=utf-8"
	case hasSuffix(path, ".png"):
		return "image/png"
	case hasSuffix(path, ".jpg", ".jpeg"):
		return "image/jpeg"
	case hasSuffix(path, ".svg"):
		return "image/svg+xml"
	default:
		return "application/octet-stream"
	}
}

func hasSuffix(s string, suffixes ...string) bool {
	for _, suf := range suffixes {
		n := len(s)
		if n >= len(suf) && s[n-len(suf):] == suf {
			return true
		}
	}
	return false
}

// ── GET /ws/execute (WebSocket) ───────────────────────────────────────────────
//
// Protocol:
//   Client → server: JSON  { wasm_b64, label, session_id, timeout_ms }
//   Server → client: binary frames  (raw stdout/stderr bytes as they arrive)
//   Server → client: JSON final     { type:"exit", code:<int>, elapsed_ms:<int> }

type wsExecuteReq struct {
	WASMB64   string `json:"wasm_b64"`
	Label     string `json:"label"`
	SessionID string `json:"session_id"`
	TimeoutMS uint64 `json:"timeout_ms"`
}

func (h *Handler) WSExecute(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("session_id")
	h.log.Debug("[ws:1/6] upgrade: accepting WebSocket connection",
		zap.String("session_id", sessionID),
		zap.String("remote", r.RemoteAddr),
	)

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,                     // origin check handled by JWT middleware upstream
		CompressionMode:    websocket.CompressionDisabled, // prevent RSV-bit mismatch with browsers
	})
	if err != nil {
		h.log.Warn("ws: accept failed", zap.Error(err))
		return
	}
	defer conn.CloseNow() //nolint:errcheck

	h.log.Debug("[ws:2/6] upgrade: WebSocket accepted — waiting for execute request",
		zap.String("session_id", sessionID),
	)

	// Read the execute request using the plain HTTP request context.
	// IMPORTANT: do NOT call conn.CloseRead before this — CloseRead starts a
	// goroutine that discards incoming data frames, which would consume the
	// client's first (and only) message before wsjson.Read can see it.
	var req wsExecuteReq
	if err := wsjson.Read(r.Context(), conn, &req); err != nil {
		h.log.Debug("ws: read request failed", zap.Error(err))
		return
	}

	h.log.Debug("[ws:3/6] request received",
		zap.String("session_id", req.SessionID),
		zap.String("label", req.Label),
		zap.Int("wasm_b64_len", len(req.WASMB64)),
		zap.Uint64("timeout_ms", req.TimeoutMS),
	)

	if req.WASMB64 == "" {
		h.log.Warn("ws: missing wasm_b64", zap.String("session_id", req.SessionID))
		_ = wsjson.Write(r.Context(), conn, map[string]any{"type": "error", "message": "wasm_b64 required"})
		conn.Close(websocket.StatusUnsupportedData, "wasm_b64 required")
		return
	}

	wasmBytes, err := base64.StdEncoding.DecodeString(req.WASMB64)
	if err != nil {
		h.log.Warn("ws: invalid base64", zap.String("session_id", req.SessionID), zap.Error(err))
		_ = wsjson.Write(r.Context(), conn, map[string]any{"type": "error", "message": "invalid base64"})
		conn.Close(websocket.StatusUnsupportedData, "invalid wasm_b64")
		return
	}

	h.log.Debug("[ws:4/6] WASM decoded — handing off to pool.Manager.Execute",
		zap.String("session_id", req.SessionID),
		zap.Int("wasm_bytes", len(wasmBytes)),
	)

	// Now that we've read the only inbound message, start CloseRead.  This
	// discards any further client→server frames and returns a context that is
	// cancelled if the client disconnects, so long-running WASM jobs are
	// cancelled automatically when the browser tab closes.
	ctx := conn.CloseRead(r.Context())

	timeout := time.Duration(req.TimeoutMS) * time.Millisecond
	if timeout == 0 {
		timeout = 30 * time.Second
	}

	result, err := h.manager.Execute(ctx, &worker.ExecuteRequest{
		WASMBytes: wasmBytes,
		Label:     req.Label,
		SessionID: req.SessionID,
		Timeout:   timeout,
	})
	if err != nil {
		h.log.Warn("ws: execution failed",
			zap.String("session_id", req.SessionID),
			zap.Error(err),
		)
		_ = wsjson.Write(ctx, conn, map[string]any{"type": "error", "message": err.Error()})
		conn.Close(websocket.StatusInternalError, "execution failed")
		return
	}

	h.log.Debug("[ws:5/6] execution complete — streaming output",
		zap.String("session_id", req.SessionID),
		zap.Int("stdout_bytes", len(result.Stdout)),
		zap.Int("stderr_bytes", len(result.Stderr)),
		zap.Int32("exit_code", result.ExitCode),
	)

	// Stream stdout as binary frames (chunked to avoid large single write).
	const chunkSize = 4096
	for i := 0; i < len(result.Stdout); i += chunkSize {
		end := i + chunkSize
		if end > len(result.Stdout) {
			end = len(result.Stdout)
		}
		if err := conn.Write(ctx, websocket.MessageBinary, result.Stdout[i:end]); err != nil {
			return
		}
	}
	// Stream stderr similarly (prefixed with ANSI red so it's visually distinct).
	if len(result.Stderr) > 0 {
		prefix := []byte("\x1b[31m")
		suffix := []byte("\x1b[0m")
		for i := 0; i < len(result.Stderr); i += chunkSize {
			end := i + chunkSize
			if end > len(result.Stderr) {
				end = len(result.Stderr)
			}
			frame := append(prefix, result.Stderr[i:end]...)
			frame = append(frame, suffix...)
			if err := conn.Write(ctx, websocket.MessageBinary, frame); err != nil {
				return
			}
		}
	}

	// Send final exit message, including VFS snapshot so the frontend can
	// populate the file tree even when VFS persistence is disabled (no LIBSQL_URL).
	// Go's JSON encoder base64-encodes []byte map values automatically, so the
	// frontend receives { "/workspace/output.txt": "<base64>", ... }.
	exitMsg := map[string]any{
		"type":       "exit",
		"code":       result.ExitCode,
		"elapsed_ms": result.TotalMS,
	}
	if len(result.VFSSnapshot) > 0 {
		exitMsg["vfs_snapshot"] = result.VFSSnapshot
	}
	_ = wsjson.Write(ctx, conn, exitMsg)

	h.log.Debug("[ws:6/6] exit frame sent — closing connection",
		zap.String("session_id", req.SessionID),
		zap.Int32("exit_code", result.ExitCode),
		zap.Uint64("total_ms", result.TotalMS),
	)
	conn.Close(websocket.StatusNormalClosure, "done")
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
