package worker_test

// Tests for HTTPWorkerClient covering the fields added in the recent audit:
//   - timeout_ms forwarded to the Rust worker when req.Timeout > 0
//   - timeout_ms absent from JSON when req.Timeout == 0 (omitempty)
//   - SessionID carried from request through to ExecuteResponse
//
// No real Rust worker needed — all tests use httptest.Server.
//
// Run:
//   go test ./internal/worker/... -race -v

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/lucasho/isolator-v/orchestrator/internal/worker"
)

// minimalWASMHeader is the 4-byte WASM magic number — enough to pass the
// base64 round-trip in Execute without a full valid module.
var minimalWASMHeader = []byte{0x00, 0x61, 0x73, 0x6d}

// okWorker returns a fake Rust worker handler that always responds 200 with
// the given sandbox_id.
func okWorker(sandboxID string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"sandbox_id": sandboxID,
			"exit_code":  0,
			"elapsed_ms": 1,
		})
	}
}

// ── timeout_ms forwarding ─────────────────────────────────────────────────────

func TestHTTPWorkerClient_Execute_ForwardsTimeoutMs(t *testing.T) {
	var gotTimeoutMs uint64

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			TimeoutMs uint64 `json:"timeout_ms"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		gotTimeoutMs = body.TimeoutMs
		okWorker("s")(w, r)
	}))
	defer srv.Close()

	c := worker.NewHTTPClient(srv.URL)
	if _, err := c.Execute(context.Background(), &worker.ExecuteRequest{
		WASMBytes: minimalWASMHeader,
		Timeout:   250 * time.Millisecond,
	}); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if gotTimeoutMs != 250 {
		t.Errorf("timeout_ms sent to worker: want 250, got %d", gotTimeoutMs)
	}
}

func TestHTTPWorkerClient_Execute_ZeroTimeoutOmittedFromBody(t *testing.T) {
	var timeoutFieldPresent bool

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Decode into a raw map so we can tell whether the key was present at all.
		var body map[string]json.RawMessage
		json.NewDecoder(r.Body).Decode(&body)
		_, timeoutFieldPresent = body["timeout_ms"]
		okWorker("s")(w, r)
	}))
	defer srv.Close()

	c := worker.NewHTTPClient(srv.URL)
	c.Execute(context.Background(), &worker.ExecuteRequest{ //nolint:errcheck
		WASMBytes: minimalWASMHeader,
		// Timeout: 0 — omitempty should exclude the field entirely
	})

	if timeoutFieldPresent {
		t.Error("timeout_ms should be absent from the JSON body when req.Timeout == 0")
	}
}

func TestHTTPWorkerClient_Execute_TimeoutMsMatchesDurationInMs(t *testing.T) {
	tests := []struct {
		name      string
		timeout   time.Duration
		wantMs    uint64
	}{
		{"100ms", 100 * time.Millisecond, 100},
		{"1s", 1 * time.Second, 1000},
		{"500ms", 500 * time.Millisecond, 500},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotMs uint64
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					TimeoutMs uint64 `json:"timeout_ms"`
				}
				json.NewDecoder(r.Body).Decode(&body)
				gotMs = body.TimeoutMs
				okWorker("s")(w, r)
			}))
			defer srv.Close()

			c := worker.NewHTTPClient(srv.URL)
			c.Execute(context.Background(), &worker.ExecuteRequest{ //nolint:errcheck
				WASMBytes: minimalWASMHeader,
				Timeout:   tt.timeout,
			})

			if gotMs != tt.wantMs {
				t.Errorf("timeout_ms: want %d, got %d", tt.wantMs, gotMs)
			}
		})
	}
}

// ── SessionID propagation ─────────────────────────────────────────────────────

func TestHTTPWorkerClient_Execute_SessionIDPropagatedToResponse(t *testing.T) {
	srv := httptest.NewServer(okWorker("sandbox-1"))
	defer srv.Close()

	c := worker.NewHTTPClient(srv.URL)
	resp, err := c.Execute(context.Background(), &worker.ExecuteRequest{
		WASMBytes: minimalWASMHeader,
		SessionID: "session-abc",
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if resp.SessionID != "session-abc" {
		t.Errorf("SessionID: want %q, got %q", "session-abc", resp.SessionID)
	}
}

func TestHTTPWorkerClient_Execute_EmptySessionIDPreserved(t *testing.T) {
	srv := httptest.NewServer(okWorker("s"))
	defer srv.Close()

	c := worker.NewHTTPClient(srv.URL)
	resp, err := c.Execute(context.Background(), &worker.ExecuteRequest{
		WASMBytes: minimalWASMHeader,
		// SessionID: "" intentionally empty
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if resp.SessionID != "" {
		t.Errorf("empty SessionID should stay empty; got %q", resp.SessionID)
	}
}

// ── Error handling ────────────────────────────────────────────────────────────

func TestHTTPWorkerClient_Execute_Worker500ReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]any{
			"error": "sandbox crashed",
			"code":  "INTERNAL_ERROR",
		})
	}))
	defer srv.Close()

	c := worker.NewHTTPClient(srv.URL)
	_, err := c.Execute(context.Background(), &worker.ExecuteRequest{WASMBytes: minimalWASMHeader})
	if err == nil {
		t.Fatal("want error on 500 response, got nil")
	}
}

func TestHTTPWorkerClient_Execute_Worker400WithErrorFieldReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Some Rust errors return 200 with a non-empty error field.
		json.NewEncoder(w).Encode(map[string]any{
			"error": "invalid wasm",
			"code":  "INVALID_INPUT",
		})
	}))
	defer srv.Close()

	c := worker.NewHTTPClient(srv.URL)
	_, err := c.Execute(context.Background(), &worker.ExecuteRequest{WASMBytes: minimalWASMHeader})
	if err == nil {
		t.Fatal("want error when response body contains non-empty error field, got nil")
	}
}

func TestHTTPWorkerClient_Execute_ContextCancelledMidFlight(t *testing.T) {
	// done is closed by a defer so the handler goroutine always unblocks before
	// srv.Close() tries to wait for it.  Defer order is LIFO, so we register
	// srv.Close() first and close(done) second — close(done) runs first.
	done := make(chan struct{})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Block until either the server is tearing down (done closed) or the
		// underlying connection is reset (r.Context() cancelled by the server).
		select {
		case <-done:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()   // runs second (registered first)
	defer close(done)   // runs first  (registered second) — unblocks handler

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	c := worker.NewHTTPClient(srv.URL)
	_, err := c.Execute(ctx, &worker.ExecuteRequest{WASMBytes: minimalWASMHeader})
	if err == nil {
		t.Fatal("want error when context is cancelled, got nil")
	}
}

// ── Health ────────────────────────────────────────────────────────────────────

func TestHTTPWorkerClient_Health_ReturnsHealthyOnOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"status":     "ok",
			"warm_slots": 10,
		})
	}))
	defer srv.Close()

	c := worker.NewHTTPClient(srv.URL)
	h, err := c.Health(context.Background())
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	if !h.Healthy {
		t.Error("Health: want Healthy=true")
	}
	if h.WarmSlots != 10 {
		t.Errorf("Health: WarmSlots want 10, got %d", h.WarmSlots)
	}
}
