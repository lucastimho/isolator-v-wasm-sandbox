package pool_test

import (
	"context"
	"testing"
	"time"

	"github.com/lucasho/isolator-v/orchestrator/internal/pool"
	"github.com/lucasho/isolator-v/orchestrator/internal/worker"
)

// ── helpers ───────────────────────────────────────────────────────────────────

// stubClient is the simplest possible worker.Client — it does nothing.
type stubClient struct{ addr string }

func (s *stubClient) Execute(_ context.Context, _ *worker.ExecuteRequest) (*worker.ExecuteResponse, error) {
	return &worker.ExecuteResponse{SandboxID: "stub", ExitCode: 0}, nil
}
func (s *stubClient) Health(_ context.Context) (*worker.HealthStatus, error) {
	return &worker.HealthStatus{Healthy: true}, nil
}
func (s *stubClient) Addr() string  { return s.addr }
func (s *stubClient) Close() error  { return nil }

func newStub(addr string) worker.Client { return &stubClient{addr: addr} }

// ── WarmPool tests ────────────────────────────────────────────────────────────

func TestWarmPool_LenAndCap(t *testing.T) {
	p := pool.NewWarmPool(5)
	if p.Cap() != 5 {
		t.Fatalf("Cap: want 5, got %d", p.Cap())
	}
	if p.Len() != 0 {
		t.Fatalf("Len before Put: want 0, got %d", p.Len())
	}
}

func TestWarmPool_PutAndGet(t *testing.T) {
	p := pool.NewWarmPool(3)
	c := newStub("worker-1")

	p.Put(c)
	if p.Len() != 1 {
		t.Fatalf("Len after Put: want 1, got %d", p.Len())
	}

	ctx := context.Background()
	got, err := p.Get(ctx)
	if err != nil {
		t.Fatalf("Get returned unexpected error: %v", err)
	}
	if got.Addr() != c.Addr() {
		t.Fatalf("Get returned wrong client: want %q, got %q", c.Addr(), got.Addr())
	}
	if p.Len() != 0 {
		t.Fatalf("Len after Get: want 0, got %d", p.Len())
	}
}

func TestWarmPool_GetBlocksUntilPut(t *testing.T) {
	p := pool.NewWarmPool(2)
	c := newStub("worker-2")

	// Put the client from a goroutine after a short delay.
	go func() {
		time.Sleep(30 * time.Millisecond)
		p.Put(c)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	got, err := p.Get(ctx)
	if err != nil {
		t.Fatalf("Get timed out waiting for client: %v", err)
	}
	if got.Addr() != c.Addr() {
		t.Fatalf("Get returned wrong client")
	}
}

func TestWarmPool_GetCancelledContext(t *testing.T) {
	p := pool.NewWarmPool(2)
	// Pool is empty; cancel the context immediately.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := p.Get(ctx)
	if err == nil {
		t.Fatal("Get on empty pool with cancelled context: want error, got nil")
	}
}

func TestWarmPool_GetTimesOut(t *testing.T) {
	p := pool.NewWarmPool(2)
	// Pool is empty; expect timeout.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	_, err := p.Get(ctx)
	if err == nil {
		t.Fatal("Get on empty pool: want ErrPoolExhausted, got nil")
	}
}

func TestWarmPool_PutSilentlyDropsWhenFull(t *testing.T) {
	const cap = 3
	p := pool.NewWarmPool(cap)

	// Fill to capacity.
	for i := 0; i < cap; i++ {
		p.Put(newStub("worker"))
	}
	if p.Len() != cap {
		t.Fatalf("Len at capacity: want %d, got %d", cap, p.Len())
	}

	// One more Put: should be silently dropped.
	p.Put(newStub("overflow"))
	if p.Len() != cap {
		t.Fatalf("Len after overflow Put: want %d (capped), got %d", cap, p.Len())
	}
}

func TestWarmPool_RoundTrip_MultipleClients(t *testing.T) {
	p := pool.NewWarmPool(4)
	addrs := []string{"w1", "w2", "w3"}

	for _, a := range addrs {
		p.Put(newStub(a))
	}
	if p.Len() != 3 {
		t.Fatalf("Len: want 3, got %d", p.Len())
	}

	ctx := context.Background()
	for range addrs {
		_, err := p.Get(ctx)
		if err != nil {
			t.Fatalf("Get: unexpected error: %v", err)
		}
	}
	if p.Len() != 0 {
		t.Fatalf("Len after draining: want 0, got %d", p.Len())
	}
}
