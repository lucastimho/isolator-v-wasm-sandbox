package pool_test

// Benchmarks and timeout-propagation tests for Manager.Execute.
//
// Run benchmarks only (skips regular tests):
//
//	go test ./internal/pool/... -bench=. -benchtime=5s -benchmem -run=^$
//
// Run everything in this file:
//
//	go test ./internal/pool/... -race -v -run=TestManager_Timeout
//	go test ./internal/pool/... -bench=. -benchtime=5s -benchmem -run=^$

import (
	"context"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/lucasho/isolator-v/orchestrator/internal/pool"
	"github.com/lucasho/isolator-v/orchestrator/internal/worker"
)

// ── Timeout propagation ───────────────────────────────────────────────────────

// TestManager_Execute_ReqTimeoutOverridesExecTimeout verifies that a
// per-request req.Timeout tighter than the server-wide ExecTimeout is
// actually applied to the context deadline.
func TestManager_Execute_ReqTimeoutOverridesExecTimeout(t *testing.T) {
	// Worker blocks until its context is cancelled.
	c := &mockClient{
		addr: "http://w",
		executeFunc: func(ctx context.Context, _ *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}

	// newManager sets ExecTimeout: 2s — much longer than our per-request 60ms.
	m := newManager(t, []worker.Client{c}, 2, nil)

	start := time.Now()
	_, err := m.Execute(context.Background(), &worker.ExecuteRequest{
		Label:   "tight-deadline",
		Timeout: 60 * time.Millisecond,
	})
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("want deadline-exceeded error, got nil")
	}
	// Should have stopped in roughly 60ms, not 2s.
	if elapsed > 500*time.Millisecond {
		t.Errorf("per-request timeout not applied: elapsed %v, want ~60ms", elapsed)
	}
}

// TestManager_Execute_ReqTimeoutIgnoredWhenLargerThanServerCap verifies that
// a req.Timeout larger than the server-wide ExecTimeout does not extend the
// deadline beyond the server cap.
func TestManager_Execute_ReqTimeoutIgnoredWhenLargerThanServerCap(t *testing.T) {
	var observedDeadline time.Time

	c := &mockClient{
		addr: "http://w",
		executeFunc: func(ctx context.Context, _ *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
			if d, ok := ctx.Deadline(); ok {
				observedDeadline = d
			}
			return &worker.ExecuteResponse{SandboxID: "s"}, nil
		},
	}

	// newManager uses ExecTimeout: 2s.
	m := newManager(t, []worker.Client{c}, 2, nil)

	beforeCall := time.Now()
	if _, err := m.Execute(context.Background(), &worker.ExecuteRequest{
		Label:   "loose-deadline",
		Timeout: 30 * time.Second, // much larger than the 2s server cap
	}); err != nil {
		t.Fatalf("Execute: unexpected error: %v", err)
	}

	// The context deadline must be no more than 2s after the call started.
	// Allow 500ms slop for scheduling jitter.
	maxAllowed := beforeCall.Add(2*time.Second + 500*time.Millisecond)
	if observedDeadline.After(maxAllowed) {
		t.Errorf("req.Timeout should be capped by server ExecTimeout;\ndeadline=%v, maxAllowed=%v",
			observedDeadline, maxAllowed)
	}
}

// TestManager_Execute_ZeroReqTimeoutUsesServerDefault verifies that when
// req.Timeout is 0 the server-wide ExecTimeout is used unchanged.
func TestManager_Execute_ZeroReqTimeoutUsesServerDefault(t *testing.T) {
	var observedDeadline time.Time

	c := &mockClient{
		addr: "http://w",
		executeFunc: func(ctx context.Context, _ *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
			if d, ok := ctx.Deadline(); ok {
				observedDeadline = d
			}
			return &worker.ExecuteResponse{SandboxID: "s"}, nil
		},
	}

	m := newManager(t, []worker.Client{c}, 2, nil) // ExecTimeout: 2s
	beforeCall := time.Now()

	if _, err := m.Execute(context.Background(), &worker.ExecuteRequest{
		Label: "default-timeout",
		// Timeout: 0  — should use server-wide 2s
	}); err != nil {
		t.Fatalf("Execute: unexpected error: %v", err)
	}

	// Deadline should be ~2s from the call time.
	wantMin := beforeCall.Add(1500 * time.Millisecond)
	wantMax := beforeCall.Add(2500 * time.Millisecond)
	if observedDeadline.Before(wantMin) || observedDeadline.After(wantMax) {
		t.Errorf("default deadline out of expected range: got %v, want in [%v, %v]",
			observedDeadline, wantMin, wantMax)
	}
}

// ── Benchmarks ────────────────────────────────────────────────────────────────

// BenchmarkManager_Execute_Throughput measures orchestration overhead with a
// zero-latency mock worker. Values above ~300µs/op indicate lock contention or
// context machinery bottlenecks unrelated to the WASM worker.
//
// Target: orchestration overhead < 1ms/op
func BenchmarkManager_Execute_Throughput(b *testing.B) {
	c := &mockClient{
		addr: "http://bench-worker",
		executeFunc: func(_ context.Context, _ *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
			return &worker.ExecuteResponse{SandboxID: "s", ExitCode: 0}, nil
		},
	}
	m := pool.NewManager(pool.ManagerConfig{
		WorkerClients: []worker.Client{c},
		PoolCapacity:  50,
		ExecTimeout:   5 * time.Second,
		Log:           zap.NewNop(),
	})
	defer m.Close()

	req := &worker.ExecuteRequest{
		WASMBytes: []byte{0x00, 0x61, 0x73, 0x6d},
		Label:     "bench",
	}

	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if _, err := m.Execute(context.Background(), req); err != nil {
				b.Fatal(err)
			}
		}
	})
}

// BenchmarkManager_Execute_P99Latency measures tail latency under realistic
// concurrency (10 goroutines competing for 50 pool slots) with a simulated
// 5ms WASM execution. End-to-end should stay under 10ms if the pool and
// context machinery add < 5ms of overhead.
//
// Target: total round-trip < 50ms at P99 with a 5ms worker
func BenchmarkManager_Execute_P99Latency(b *testing.B) {
	c := &mockClient{
		addr: "http://bench-worker",
		executeFunc: func(_ context.Context, _ *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
			time.Sleep(5 * time.Millisecond) // simulate a realistic WASM execution
			return &worker.ExecuteResponse{SandboxID: "s"}, nil
		},
	}
	m := pool.NewManager(pool.ManagerConfig{
		WorkerClients: []worker.Client{c},
		PoolCapacity:  50,
		ExecTimeout:   5 * time.Second,
		Log:           zap.NewNop(),
	})
	defer m.Close()

	req := &worker.ExecuteRequest{WASMBytes: []byte{0x00, 0x61, 0x73, 0x6d}, Label: "p99"}
	b.SetParallelism(10)
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			m.Execute(context.Background(), req) //nolint:errcheck
		}
	})
}
