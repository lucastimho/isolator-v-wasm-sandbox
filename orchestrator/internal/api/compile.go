package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"go.uber.org/zap"
)

// ── POST /compile ────────────────────────────────────────────────────────────
//
// Accepts Rust source code, compiles it to wasm32-wasip1, and returns the
// resulting WASM binary as a base64 string.  This enables the frontend code
// editor to submit arbitrary Rust programs for sandbox execution without
// requiring a local toolchain.
//
// Request:
//
//	{
//	  "source": "fn main() { println!(\"hello\"); }",
//	  "edition": "2021"   // optional, defaults to "2021"
//	}
//
// Response (200):
//
//	{
//	  "wasm_b64":     "<base64 WASM binary>",
//	  "wasm_bytes":   1234,
//	  "compile_ms":   850,
//	  "warnings":     "warning: unused variable..."
//	}
//
// Response (400 — compilation error):
//
//	{
//	  "error":       "compilation_failed",
//	  "stderr":      "error[E0308]: mismatched types...",
//	  "compile_ms":  420
//	}

type compileReq struct {
	Source  string `json:"source"`
	Edition string `json:"edition"` // "2015", "2018", "2021" (default)
}

type compileOK struct {
	WasmB64   string `json:"wasm_b64"`
	WasmBytes int    `json:"wasm_bytes"`
	CompileMS int64  `json:"compile_ms"`
	Warnings  string `json:"warnings,omitempty"`
}

type compileErr struct {
	Error     string `json:"error"`
	Stderr    string `json:"stderr"`
	CompileMS int64  `json:"compile_ms"`
}

// Compile handles POST /compile.
func (h *Handler) Compile(w http.ResponseWriter, r *http.Request) {
	// ── Parse request ────────────────────────────────────────────────────
	var req compileReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid_json"}`, http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Source) == "" {
		http.Error(w, `{"error":"empty_source"}`, http.StatusBadRequest)
		return
	}
	edition := req.Edition
	if edition == "" {
		edition = "2021"
	}

	h.log.Info("compile request",
		zap.Int("source_len", len(req.Source)),
		zap.String("edition", edition),
	)

	// ── Create temp project ──────────────────────────────────────────────
	tmpDir, err := os.MkdirTemp("", "isolator-compile-*")
	if err != nil {
		h.log.Error("failed to create temp dir", zap.Error(err))
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	defer os.RemoveAll(tmpDir)

	srcPath := filepath.Join(tmpDir, "main.rs")
	if err := os.WriteFile(srcPath, []byte(req.Source), 0644); err != nil {
		h.log.Error("failed to write source", zap.Error(err))
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}

	outPath := filepath.Join(tmpDir, "main.wasm")

	// ── Compile with rustc ───────────────────────────────────────────────
	// Using rustc directly (not cargo) for speed — no Cargo.toml, no
	// dependency resolution, just a single-file compile.  This is
	// intentional: sandbox agents should be self-contained.
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	start := time.Now()
	cmd := exec.CommandContext(ctx, "rustc",
		"--target", "wasm32-wasip1",
		"--edition", edition,
		"-O",            // optimise (release mode)
		"-o", outPath,
		srcPath,
	)
	// Capture both stdout and stderr from rustc.
	var stderr strings.Builder
	cmd.Stderr = &stderr
	cmd.Stdout = &stderr // rustc writes diagnostics to stderr, but just in case

	runErr := cmd.Run()
	compileMS := time.Since(start).Milliseconds()

	// ── Handle compile failure ───────────────────────────────────────────
	if runErr != nil {
		h.log.Info("compilation failed",
			zap.Int64("compile_ms", compileMS),
			zap.String("stderr_preview", truncate(stderr.String(), 500)),
		)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(compileErr{
			Error:     "compilation_failed",
			Stderr:    stderr.String(),
			CompileMS: compileMS,
		})
		return
	}

	// ── Read compiled WASM ───────────────────────────────────────────────
	wasmBytes, err := os.ReadFile(outPath)
	if err != nil {
		h.log.Error("failed to read compiled wasm", zap.Error(err))
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}

	wasmB64 := base64.StdEncoding.EncodeToString(wasmBytes)

	h.log.Info("compilation succeeded",
		zap.Int64("compile_ms", compileMS),
		zap.Int("wasm_bytes", len(wasmBytes)),
		zap.String("warnings_preview", truncate(stderr.String(), 200)),
	)

	// ── Return compiled binary ───────────────────────────────────────────
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(compileOK{
		WasmB64:   wasmB64,
		WasmBytes: len(wasmBytes),
		CompileMS: compileMS,
		Warnings:  stderr.String(),
	})
}

// truncate returns s capped at maxLen, appending "…" if truncated.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + fmt.Sprintf("… (%d bytes total)", len(s))
}
