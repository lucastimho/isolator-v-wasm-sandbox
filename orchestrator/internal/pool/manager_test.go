package pool_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/lucasho/isolator-v/orchestrator/internal/pool"
	"github.com/lucasho/isolator-v/orchestrator/internal/worker"
)

// ── mock worker.Client ────────────────────────────────────────────────────────

// mockClient lets individual tests control Execute and Health behaviour.
type mockClient struct {
	addr        string
	executeFunc func(context.Context, *worker.ExecuteRequest) (*worker.ExecuteResponse, error)
	healthFunc  func(context.Context) (*worker.HealthStatus, error)
	closeCalled atomic.Bool
}

func (m *mockClient) Execute(ctx context.Context, req *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
	if m.executeFunc != nil {
		return m.executeFunc(ctx, req)
	}
	return &worker.ExecuteResponse{SandboxID: "mock-sandbox", ExitCode: 0}, nil
}

func (m *mockClient) Health(ctx context.Context) (*worker.HealthStatus, error) {
	if m.healthFunc != nil {
		return m.healthFunc(ctx)
	}
	return &worker.HealthStatus{Healthy: true, WarmSlots: 10, Addr: m.addr}, nil
}

func (m *mockClient) Addr() string { return m.addr }
func (m *mockClient) Close() error { m.closeCalled.Store(true); return nil }

// newManager builds a Manager wired up for tests: no VFS channel, short
// timeouts, and a nop logger.  Callers must defer m.Close().
func newManager(t *testing.T, clients []worker.Client, capacity int, vfsCh chan *worker.ExecuteResponse) *pool.Manager {
	t.Helper()
	log, _ := zap.NewDevelopment()
	m := pool.NewManager(pool.ManagerConfig{
		WorkerClients:  clients,
		PoolCapacity:   capacity,
		AcquireTimeout: 200 * time.Millisecond,
		ExecTimeout:    2 * time.Second,
		VFSCh:          vfsCh,
		Log:            log,
	})
	t.Cleanup(m.Close)
	return m
}

// ── Execute ───────────────────────────────────────────────────────────────────

func TestManager_Execute_HappyPath(t *testing.T) {
	want := &worker.ExecuteResponse{
		SandboxID: "sandbox-42",
		Stdout:    []byte("hello"),
		ExitCode:  0,
		ElapsedMS: 7,
	}
	c := &mockClient{
		addr: "http://worker-1",
		executeFunc: func(_ context.Context, _ *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
			return want, nil
		},
	}

	m := newManager(t, []worker.Client{c}, 2, nil)

	result, err := m.Execute(context.Background(), &worker.ExecuteRequest{
		WASMBytes: []byte{0x00, 0x61, 0x73, 0x6d},
		Label:     "test",
	})
	if err != nil {
		t.Fatalf("Execute returned unexpected error: %v", err)
	}
	if result.SandboxID != want.SandboxID {
		t.Errorf("SandboxID: want %q, got %q", want.SandboxID, result.SandboxID)
	}
	if string(result.Stdout) != string(want.Stdout) {
		t.Errorf("Stdout: want %q, got %q", want.Stdout, result.Stdout)
	}
	if result.WorkerAddr != c.addr {
		t.Errorf("WorkerAddr: want %q, got %q", c.addr, result.WorkerAddr)
	}
}

func TestManager_Execute_WorkerError(t *testing.T) {
	workerErr := errors.New("sandbox exploded")
	c := &mockClient{
		addr: "http://bad-worker",
		executeFunc: func(_ context.Context, _ *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
			return nil, workerErr
		},
	}

	m := newManager(t, []worker.Client{c}, 2, nil)

	_, err := m.Execute(context.Background(), &worker.ExecuteRequest{Label: "boom"})
	if err == nil {
		t.Fatal("Execute: want error, got nil")
	}
	if !errors.Is(err, workerErr) {
		t.Errorf("Execute error should wrap worker error; got: %v", err)
	}

	stats := m.Stats()
	if stats["failed_execs"].(int64) != 1 {
		t.Errorf("failed_execs: want 1, got %v", stats["failed_execs"])
	}
}

func TestManager_Execute_IncrementsTotalExecs(t *testing.T) {
	c := &mockClient{addr: "http://w"}
	m := newManager(t, []worker.Client{c}, 2, nil)

	for i := 0; i < 3; i++ {
		m.Execute(context.Background(), &worker.ExecuteRequest{Label: "ping"}) //nolint:errcheck
	}

	stats := m.Stats()
	if stats["total_execs"].(int64) != 3 {
		t.Errorf("total_execs: want 3, got %v", stats["total_execs"])
	}
}

func TestManager_Execute_PoolExhausted(t *testing.T) {
	// Slow worker that sleeps longer than the acquire timeout.
	c := &mockClient{
		addr: "http://slow",
		executeFunc: func(ctx context.Context, _ *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
			<-ctx.Done() // block until context cancelled
			return nil, ctx.Err()
		},
	}

	m := newManager(t, []worker.Client{c}, 1, nil) // pool size = 1

	// Fire one execution that will hold the single slot.
	go m.Execute(context.Background(), &worker.ExecuteRequest{Label: "slot-holder"}) //nolint:errcheck

	// Give the goroutine a moment to acquire the slot.
	time.Sleep(30 * time.Millisecond)

	// Second call should exhaust the pool within AcquireTimeout (200 ms).
	_, err := m.Execute(context.Background(), &worker.ExecuteRequest{Label: "waiter"})
	if err == nil {
		t.Fatal("Execute: want ErrPoolExhausted, got nil")
	}
	if !errors.Is(err, pool.ErrPoolExhausted) {
		t.Errorf("error should wrap ErrPoolExhausted; got: %v", err)
	}
}

func TestManager_Execute_VFSSnapshotForwarded(t *testing.T) {
	snapshot := map[string][]byte{"/workspace/out.txt": []byte("result")}
	c := &mockClient{
		addr: "http://w",
		executeFunc: func(_ context.Context, _ *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
			return &worker.ExecuteResponse{SandboxID: "s", VFSSnapshot: snapshot}, nil
		},
	}

	vfsCh := make(chan *worker.ExecuteResponse, 4)
	m := newManager(t, []worker.Client{c}, 2, vfsCh)

	_, err := m.Execute(context.Background(), &worker.ExecuteRequest{Label: "vfs-test"})
	if err != nil {
		t.Fatalf("Execute: unexpected error: %v", err)
	}

	select {
	case resp := <-vfsCh:
		if string(resp.VFSSnapshot["/workspace/out.txt"]) != "result" {
			t.Errorf("VFS snapshot content mismatch")
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("VFS snapshot not forwarded to channel within timeout")
	}
}

func TestManager_Execute_VFSSnapshotDroppedWhenChannelFull(t *testing.T) {
	snapshot := map[string][]byte{"/out": []byte("data")}
	c := &mockClient{
		addr: "http://w",
		executeFunc: func(_ context.Context, _ *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
			return &worker.ExecuteResponse{SandboxID: "s", VFSSnapshot: snapshot}, nil
		},
	}

	// Channel with capacity 0 — always full, so snapshots are dropped.
	vfsCh := make(chan *worker.ExecuteResponse, 0)
	m := newManager(t, []worker.Client{c}, 2, vfsCh)

	// This must not block even though the channel is full.
	_, err := m.Execute(context.Background(), &worker.ExecuteRequest{Label: "drop-test"})
	if err != nil {
		t.Fatalf("Execute: unexpected error (should not block on full vfsCh): %v", err)
	}
}

func TestManager_Execute_EmptyVFSSnapshotNotForwarded(t *testing.T) {
	c := &mockClient{
		addr: "http://w",
		executeFunc: func(_ context.Context, _ *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
			// Empty (nil) VFSSnapshot — should not be forwarded.
			return &worker.ExecuteResponse{SandboxID: "s"}, nil
		},
	}

	vfsCh := make(chan *worker.ExecuteResponse, 4)
	m := newManager(t, []worker.Client{c}, 2, vfsCh)

	m.Execute(context.Background(), &worker.ExecuteRequest{Label: "no-vfs"}) //nolint:errcheck

	select {
	case <-vfsCh:
		t.Fatal("empty VFS snapshot should not be forwarded to channel")
	case <-time.After(50 * time.Millisecond):
		// Good — nothing was forwarded.
	}
}

// ── Stats ─────────────────────────────────────────────────────────────────────

func TestManager_Stats_InitialValues(t *testing.T) {
	c := &mockClient{addr: "http://w"}
	m := newManager(t, []worker.Client{c}, 4, nil)

	stats := m.Stats()
	if stats["pool_cap"].(int) != 4 {
		t.Errorf("pool_cap: want 4, got %v", stats["pool_cap"])
	}
	if stats["worker_nodes"].(int) != 1 {
		t.Errorf("worker_nodes: want 1, got %v", stats["worker_nodes"])
	}
	if stats["total_execs"].(int64) != 0 {
		t.Errorf("total_execs: want 0, got %v", stats["total_execs"])
	}
	if stats["failed_execs"].(int64) != 0 {
		t.Errorf("failed_execs: want 0, got %v", stats["failed_execs"])
	}
}

func TestManager_Stats_WarmSlotsAfterReplenish(t *testing.T) {
	c := &mockClient{addr: "http://w"}
	// After NewManager, replenish() runs synchronously and fills the pool.
	m := newManager(t, []worker.Client{c}, 3, nil)

	stats := m.Stats()
	if stats["warm_slots"].(int) != 3 {
		t.Errorf("warm_slots: want 3, got %v", stats["warm_slots"])
	}
}

// ── Replenish ─────────────────────────────────────────────────────────────────

func TestManager_ReplenishLoop_RefillsAfterDrain(t *testing.T) {
	// capacity=4, replenishThreshold=0.5 → refill triggers when len<2.
	const cap = 4
	c := &mockClient{addr: "http://w"}
	m := newManager(t, []worker.Client{c}, cap, nil)

	// Drain all slots by acquiring them (Execute holds then returns each slot).
	// We use a fast worker so Execute completes quickly.
	for i := 0; i < cap; i++ {
		if _, err := m.Execute(context.Background(), &worker.ExecuteRequest{Label: "drain"}); err != nil {
			t.Logf("Execute %d: %v", i, err)
		}
	}

	// The replenishLoop runs every 250 ms.  After 600 ms the pool should be full.
	deadline := time.Now().Add(600 * time.Millisecond)
	for time.Now().Before(deadline) {
		stats := m.Stats()
		if stats["warm_slots"].(int) == cap {
			return // pool was refilled — test passes
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Errorf("warm_slots did not return to %d after replenish loop ran", cap)
}

// ── Context cancellation ──────────────────────────────────────────────────────

func TestManager_Execute_ContextCancelledBeforeAcquire(t *testing.T) {
	c := &mockClient{addr: "http://w"}
	m := newManager(t, []worker.Client{c}, 1, nil)

	// Cancel the context before Execute even starts.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := m.Execute(ctx, &worker.ExecuteRequest{Label: "cancelled"})
	if err == nil {
		t.Fatal("Execute with pre-cancelled context: want error, got nil")
	}
}

// ── Multiple workers — round-robin distribution ───────────────────────────────

func TestManager_Execute_DistributesAcrossWorkers(t *testing.T) {
	var calls [2]atomic.Int32
	workers := []worker.Client{
		&mockClient{
			addr: "w0",
			executeFunc: func(_ context.Context, _ *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
				calls[0].Add(1)
				return &worker.ExecuteResponse{SandboxID: "s0"}, nil
			},
		},
		&mockClient{
			addr: "w1",
			executeFunc: func(_ context.Context, _ *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
				calls[1].Add(1)
				return &worker.ExecuteResponse{SandboxID: "s1"}, nil
			},
		},
	}

	// Pool capacity 4 with 2 workers → replenish distributes slots evenly.
	m := newManager(t, workers, 4, nil)

	for i := 0; i < 4; i++ {
		m.Execute(context.Background(), &worker.ExecuteRequest{Label: "rr"}) //nolint:errcheck
	}

	total := int(calls[0].Load()) + int(calls[1].Load())
	if total != 4 {
		t.Errorf("total calls: want 4, got %d", total)
	}
	// Each worker should have been called roughly half the time.
	// Allow ±2 tolerance for small pool sizes.
	if calls[0].Load() == 0 || calls[1].Load() == 0 {
		t.Errorf("expected both workers to receive calls; got %d / %d",
			calls[0].Load(), calls[1].Load())
	}
}
