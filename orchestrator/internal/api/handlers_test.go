package api_test

// Handler integration tests
//
// These tests stand up a real pool.Manager backed by a fake in-process HTTP
// worker server (httptest.Server).  This exercises the full request path:
//
//   httptest client → Handler.Execute → pool.Manager → fake worker server
//
// No real Rust worker or Redis instance is required.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/lucasho/isolator-v/orchestrator/internal/api"
	"github.com/lucasho/isolator-v/orchestrator/internal/pool"
	"github.com/lucasho/isolator-v/orchestrator/internal/worker"
)

// ── minimal valid WASM binary (noop module) ───────────────────────────────────
// Bytes: \0asm version=1, type+func+export+code sections defining:
//   (module (func (export "_start")))
var minimalWASM = []byte{
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
	0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type section
	0x03, 0x02, 0x01, 0x00, // function section
	0x07, 0x0a, 0x01, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00, // export
	0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b, // code
}

func minimalWASMB64() string { return base64.StdEncoding.EncodeToString(minimalWASM) }

// ── mock worker.Client ────────────────────────────────────────────────────────

type mockWorker struct {
	addr        string
	executeFunc func(context.Context, *worker.ExecuteRequest) (*worker.ExecuteResponse, error)
}

func (m *mockWorker) Execute(ctx context.Context, req *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
	if m.executeFunc != nil {
		return m.executeFunc(ctx, req)
	}
	return &worker.ExecuteResponse{SandboxID: "test-sandbox", ExitCode: 0}, nil
}
func (m *mockWorker) Health(_ context.Context) (*worker.HealthStatus, error) {
	return &worker.HealthStatus{Healthy: true}, nil
}
func (m *mockWorker) Addr() string { return m.addr }
func (m *mockWorker) Close() error { return nil }

// ── test server setup ─────────────────────────────────────────────────────────

type testServer struct {
	srv     *httptest.Server
	manager *pool.Manager
}

func newTestServer(t *testing.T, w worker.Client) *testServer {
	t.Helper()
	log, _ := zap.NewDevelopment()
	mgr := pool.NewManager(pool.ManagerConfig{
		WorkerClients:  []worker.Client{w},
		PoolCapacity:   4,
		AcquireTimeout: 500 * time.Millisecond,
		ExecTimeout:    5 * time.Second,
		Log:            log,
	})
	t.Cleanup(mgr.Close)

	handler := api.NewHandler(mgr, nil, log)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /execute", handler.Execute)
	mux.HandleFunc("GET /health", handler.Health)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return &testServer{srv: srv, manager: mgr}
}

// post sends a POST request to the test server with a JSON body.
func (ts *testServer) post(t *testing.T, path, body string) *http.Response {
	t.Helper()
	resp, err := ts.srv.Client().Post(ts.srv.URL+path, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	return resp
}

// get sends a GET request to the test server.
func (ts *testServer) get(t *testing.T, path string) *http.Response {
	t.Helper()
	resp, err := ts.srv.Client().Get(ts.srv.URL + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	return resp
}

func decodeJSON(t *testing.T, r io.Reader, v any) {
	t.Helper()
	if err := json.NewDecoder(r).Decode(v); err != nil {
		t.Fatalf("decode JSON: %v", err)
	}
}

// ── POST /execute tests ───────────────────────────────────────────────────────

func TestExecute_MissingWASMField_Returns400(t *testing.T) {
	ts := newTestServer(t, &mockWorker{addr: "mock"})

	resp := ts.post(t, "/execute", `{"label":"test"}`)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing wasm_b64: want 400, got %d", resp.StatusCode)
	}

	var body map[string]string
	decodeJSON(t, resp.Body, &body)
	if !strings.Contains(body["error"], "wasm_b64") {
		t.Errorf("error message should mention wasm_b64; got: %q", body["error"])
	}
}

func TestExecute_InvalidBase64_Returns400(t *testing.T) {
	ts := newTestServer(t, &mockWorker{addr: "mock"})

	resp := ts.post(t, "/execute", `{"wasm_b64":"!!!not-valid-base64!!!"}`)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid base64: want 400, got %d", resp.StatusCode)
	}
}

func TestExecute_InvalidWASMMagicBytes_Returns400(t *testing.T) {
	ts := newTestServer(t, &mockWorker{addr: "mock"})

	// Valid base64 but the decoded bytes are not a WASM binary.
	notWasm := base64.StdEncoding.EncodeToString([]byte("hello world, definitely not wasm"))
	resp := ts.post(t, "/execute", `{"wasm_b64":"`+notWasm+`"}`)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad magic: want 400, got %d", resp.StatusCode)
	}

	var body map[string]string
	decodeJSON(t, resp.Body, &body)
	if !strings.Contains(body["error"], "magic") {
		t.Errorf("error should mention magic bytes; got: %q", body["error"])
	}
}

func TestExecute_WASMTooShort_Returns400(t *testing.T) {
	// WASM magic is 4 bytes + 4 version bytes = 8 bytes minimum.
	short := base64.StdEncoding.EncodeToString([]byte{0x00, 0x61, 0x73}) // only 3 bytes
	ts := newTestServer(t, &mockWorker{addr: "mock"})

	resp := ts.post(t, "/execute", `{"wasm_b64":"`+short+`"}`)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("too-short WASM: want 400, got %d", resp.StatusCode)
	}
}

func TestExecute_InvalidJSON_Returns400(t *testing.T) {
	ts := newTestServer(t, &mockWorker{addr: "mock"})

	resp := ts.post(t, "/execute", `{not valid json}`)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid JSON: want 400, got %d", resp.StatusCode)
	}
}

func TestExecute_Success_Returns200WithExpectedFields(t *testing.T) {
	wantResponse := &worker.ExecuteResponse{
		SandboxID: "sandbox-abc",
		Stdout:    []byte("hello from wasm"),
		Stderr:    []byte(""),
		ExitCode:  0,
		ElapsedMS: 12,
	}
	w := &mockWorker{
		addr: "mock",
		executeFunc: func(_ context.Context, req *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
			// Verify the WASM bytes were correctly decoded from base64.
			if string(req.WASMBytes) != string(minimalWASM) {
				t.Errorf("wasm bytes mismatch in worker request")
			}
			if req.Label != "my-agent" {
				t.Errorf("Label: want %q, got %q", "my-agent", req.Label)
			}
			return wantResponse, nil
		},
	}
	ts := newTestServer(t, w)

	body := `{"wasm_b64":"` + minimalWASMB64() + `","label":"my-agent","session_id":"sess-1"}`
	resp := ts.post(t, "/execute", body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("success case: want 200, got %d body=%s", resp.StatusCode, raw)
	}

	var result struct {
		SandboxID  string `json:"sandbox_id"`
		Stdout     []byte `json:"stdout"`
		ExitCode   int32  `json:"exit_code"`
		ElapsedMS  uint64 `json:"elapsed_ms"`
		WorkerAddr string `json:"worker_addr"`
	}
	decodeJSON(t, resp.Body, &result)

	if result.SandboxID != wantResponse.SandboxID {
		t.Errorf("sandbox_id: want %q, got %q", wantResponse.SandboxID, result.SandboxID)
	}
	if string(result.Stdout) != string(wantResponse.Stdout) {
		t.Errorf("stdout: want %q, got %q", wantResponse.Stdout, result.Stdout)
	}
	if result.ExitCode != 0 {
		t.Errorf("exit_code: want 0, got %d", result.ExitCode)
	}
	if result.WorkerAddr != "mock" {
		t.Errorf("worker_addr: want %q, got %q", "mock", result.WorkerAddr)
	}
}

func TestExecute_WorkerError_Returns500(t *testing.T) {
	w := &mockWorker{
		addr: "mock",
		executeFunc: func(_ context.Context, _ *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
			return nil, errors.New("worker crashed")
		},
	}
	ts := newTestServer(t, w)

	body := `{"wasm_b64":"` + minimalWASMB64() + `","label":"crash-test"}`
	resp := ts.post(t, "/execute", body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("worker error: want 500, got %d", resp.StatusCode)
	}
}

func TestExecute_NonZeroExitCode_IsPreserved(t *testing.T) {
	w := &mockWorker{
		addr: "mock",
		executeFunc: func(_ context.Context, _ *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
			return &worker.ExecuteResponse{SandboxID: "s", ExitCode: 42}, nil
		},
	}
	ts := newTestServer(t, w)

	body := `{"wasm_b64":"` + minimalWASMB64() + `","label":"exit-test"}`
	resp := ts.post(t, "/execute", body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}

	var result struct {
		ExitCode int32 `json:"exit_code"`
	}
	decodeJSON(t, resp.Body, &result)
	if result.ExitCode != 42 {
		t.Errorf("exit_code: want 42, got %d", result.ExitCode)
	}
}

func TestExecute_VFSSnapshot_IncludedInResponse(t *testing.T) {
	snapshot := map[string][]byte{
		"/workspace/out.txt": []byte("agent output"),
	}
	w := &mockWorker{
		addr: "mock",
		executeFunc: func(_ context.Context, _ *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
			return &worker.ExecuteResponse{SandboxID: "s", VFSSnapshot: snapshot}, nil
		},
	}
	ts := newTestServer(t, w)

	body := `{"wasm_b64":"` + minimalWASMB64() + `","label":"vfs-test"}`
	resp := ts.post(t, "/execute", body)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}

	var result struct {
		VFSSnapshot map[string][]byte `json:"vfs_snapshot"`
	}
	decodeJSON(t, resp.Body, &result)
	if result.VFSSnapshot == nil {
		t.Fatal("vfs_snapshot should be present in response")
	}
	if string(result.VFSSnapshot["/workspace/out.txt"]) != "agent output" {
		t.Errorf("vfs_snapshot content mismatch")
	}
}

func TestExecute_ContentTypeIsJSON(t *testing.T) {
	ts := newTestServer(t, &mockWorker{addr: "mock"})

	body := `{"wasm_b64":"` + minimalWASMB64() + `"}`
	resp := ts.post(t, "/execute", body)
	defer resp.Body.Close()

	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "application/json") {
		t.Errorf("Content-Type: want application/json, got %q", ct)
	}
}

// ── GET /health tests ─────────────────────────────────────────────────────────

func TestHealth_Returns200(t *testing.T) {
	ts := newTestServer(t, &mockWorker{addr: "mock"})

	resp := ts.get(t, "/health")
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("health: want 200, got %d", resp.StatusCode)
	}
}

func TestHealth_ResponseContainsPoolStats(t *testing.T) {
	ts := newTestServer(t, &mockWorker{addr: "mock"})

	resp := ts.get(t, "/health")
	defer resp.Body.Close()

	var body struct {
		Status string         `json:"status"`
		Pool   map[string]any `json:"pool"`
	}
	decodeJSON(t, resp.Body, &body)

	if body.Status != "ok" {
		t.Errorf("status: want %q, got %q", "ok", body.Status)
	}
	if body.Pool == nil {
		t.Fatal("health response missing pool stats")
	}

	for _, key := range []string{"warm_slots", "pool_cap", "worker_nodes", "total_execs", "failed_execs"} {
		if _, ok := body.Pool[key]; !ok {
			t.Errorf("pool stats missing key %q", key)
		}
	}
}

func TestHealth_ContentTypeIsJSON(t *testing.T) {
	ts := newTestServer(t, &mockWorker{addr: "mock"})

	resp := ts.get(t, "/health")
	defer resp.Body.Close()

	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "application/json") {
		t.Errorf("Content-Type: want application/json, got %q", ct)
	}
}
