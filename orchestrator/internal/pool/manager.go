package pool

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"

	"github.com/lucasho/isolator-v/orchestrator/internal/worker"
)

const (
	// acquireDefaultTimeout is how long Execute() waits for a warm slot before
	// returning ErrPoolExhausted.
	acquireDefaultTimeout = 5 * time.Second

	// execDefaultTimeout is the hard deadline applied to every WASM execution.
	// The Rust worker enforces its own CPU-quota on top of this.
	execDefaultTimeout = 30 * time.Second

	// heartbeatInterval controls how often the manager health-checks workers.
	heartbeatInterval = 10 * time.Second

	// replenishInterval controls how often the replenish loop runs.
	replenishInterval = 250 * time.Millisecond

	// replenishThreshold triggers a refill when available slots drop below
	// this fraction of total capacity.
	replenishThreshold = 0.5
)

// ExecutionResult wraps worker.ExecuteResponse with orchestration metadata.
type ExecutionResult struct {
	*worker.ExecuteResponse
	WorkerAddr string
	TotalMS    uint64
}

// ManagerConfig holds all Manager dependencies and tunables.
type ManagerConfig struct {
	WorkerClients  []worker.Client
	PoolCapacity   int
	AcquireTimeout time.Duration // 0 → acquireDefaultTimeout
	ExecTimeout    time.Duration // 0 → execDefaultTimeout
	// VFSCh is an optional channel that receives every ExecuteResponse that
	// contains a non-empty VFS snapshot.  The WriteBehindSync reads from it.
	VFSCh chan *worker.ExecuteResponse
	Log   *zap.Logger
}

// Manager is the Orchestration Layer's SandboxManager.
//
// Responsibilities:
//   - Maintain a warm pool of worker.Client connections.
//   - Route Execute() calls to a healthy worker, honouring timeouts.
//   - Forward VFS snapshots to the write-behind channel.
//   - Continuously health-check workers and remove dead ones.
//   - Replenish the warm pool when it drains below the threshold.
type Manager struct {
	log            *zap.Logger
	pool           *WarmPool
	vfsCh          chan *worker.ExecuteResponse
	acquireTimeout time.Duration
	execTimeout    time.Duration

	mu      sync.RWMutex
	workers []worker.Client

	totalExecs  atomic.Int64
	failedExecs atomic.Int64

	done chan struct{}
}

// NewManager creates a Manager and starts its background goroutines.
// Call Close() to stop them gracefully.
func NewManager(cfg ManagerConfig) *Manager {
	acquireTO := cfg.AcquireTimeout
	if acquireTO == 0 {
		acquireTO = acquireDefaultTimeout
	}
	execTO := cfg.ExecTimeout
	if execTO == 0 {
		execTO = execDefaultTimeout
	}

	m := &Manager{
		log:            cfg.Log,
		pool:           NewWarmPool(cfg.PoolCapacity),
		workers:        cfg.WorkerClients,
		vfsCh:          cfg.VFSCh,
		acquireTimeout: acquireTO,
		execTimeout:    execTO,
		done:           make(chan struct{}),
	}

	// Seed the pool immediately so the first requests don't wait.
	m.replenish()

	go m.replenishLoop()
	go m.heartbeatLoop()

	m.log.Info("sandbox manager started",
		zap.Int("pool_capacity", cfg.PoolCapacity),
		zap.Int("worker_nodes", len(cfg.WorkerClients)),
		zap.Duration("exec_timeout", execTO),
	)

	return m
}

// ── Execute ───────────────────────────────────────────────────────────────────

// Execute runs WASM bytes in a pre-warmed sandbox.
//
// Lifecycle:
//  1. Apply a per-request execution timeout (context deadline).
//     req.Timeout takes precedence when it is set and shorter than the
//     server-wide m.execTimeout — this lets callers pass a tighter deadline
//     (e.g. from the timeout_ms JSON field) without exceeding the global cap.
//  2. Acquire a warm slot from the pool (bounded by acquireTimeout).
//  3. Call the worker — it enforces its own CPU/memory quota.
//  4. Return the slot to the pool unconditionally (defer).
//  5. Forward the VFS snapshot to the write-behind channel.
func (m *Manager) Execute(ctx context.Context, req *worker.ExecuteRequest) (*ExecutionResult, error) {
	// 1 — Hard deadline: use req.Timeout when it is > 0 and tighter than the
	//     server-wide cap so individual requests can opt into shorter deadlines.
	execTO := m.execTimeout
	if req.Timeout > 0 && req.Timeout < execTO {
		execTO = req.Timeout
	}
	execCtx, execCancel := context.WithTimeout(ctx, execTO)
	defer execCancel()

	m.log.Debug("[1/4] execute: applying timeouts",
		zap.String("label", req.Label),
		zap.Duration("exec_timeout", execTO),
		zap.Duration("acquire_timeout", m.acquireTimeout),
		zap.Int("pool_len", m.pool.Len()),
		zap.Int("pool_cap", m.pool.Cap()),
	)

	// 2 — Acquire a slot (separate, shorter timeout so we fail fast on overload).
	acquireCtx, acquireCancel := context.WithTimeout(execCtx, m.acquireTimeout)
	defer acquireCancel()

	m.log.Debug("[2/4] execute: waiting for warm slot",
		zap.String("label", req.Label),
	)

	w, err := m.pool.Get(acquireCtx)
	if err != nil {
		m.log.Warn("execute: pool acquire failed",
			zap.String("label", req.Label),
			zap.Int("pool_len", m.pool.Len()),
			zap.Int("pool_cap", m.pool.Cap()),
			zap.Error(err),
		)
		return nil, fmt.Errorf("pool exhausted (capacity=%d): %w", m.pool.Cap(), err)
	}
	// Always return the slot so the pool doesn't drain permanently.
	defer m.pool.Put(w)

	m.log.Debug("[3/4] execute: slot acquired — dispatching to worker",
		zap.String("label", req.Label),
		zap.String("worker", w.Addr()),
		zap.Int("wasm_bytes", len(req.WASMBytes)),
	)

	// 3 — Execute.
	start := time.Now()
	resp, err := w.Execute(execCtx, req)
	totalMS := uint64(time.Since(start).Milliseconds())

	m.log.Debug("[4/4] execute: worker returned",
		zap.String("label", req.Label),
		zap.String("worker", w.Addr()),
		zap.Uint64("elapsed_ms", totalMS),
		zap.Bool("error", err != nil),
	)

	m.totalExecs.Add(1)
	if err != nil {
		m.failedExecs.Add(1)
		m.log.Warn("worker execution failed",
			zap.String("worker", w.Addr()),
			zap.String("label", req.Label),
			zap.Error(err),
		)
		return nil, fmt.Errorf("worker %s: %w", w.Addr(), err)
	}

	m.log.Info("execution complete",
		zap.String("sandbox_id", resp.SandboxID),
		zap.String("worker", w.Addr()),
		zap.Uint64("elapsed_ms", totalMS),
		zap.Int32("exit_code", resp.ExitCode),
	)

	// 4 — Forward VFS snapshot to write-behind service (non-blocking).
	if m.vfsCh != nil && len(resp.VFSSnapshot) > 0 {
		select {
		case m.vfsCh <- resp:
		default:
			m.log.Warn("vfs write-behind channel full — snapshot dropped",
				zap.String("sandbox_id", resp.SandboxID))
		}
	}

	return &ExecutionResult{
		ExecuteResponse: resp,
		WorkerAddr:      w.Addr(),
		TotalMS:         totalMS,
	}, nil
}

// ── Background loops ──────────────────────────────────────────────────────────

// replenish fills the warm pool up to capacity, distributing slots round-robin
// across all known healthy workers.
func (m *Manager) replenish() {
	m.mu.RLock()
	workers := m.workers
	m.mu.RUnlock()

	if len(workers) == 0 {
		return
	}

	needed := m.pool.Cap() - m.pool.Len()
	for i := 0; i < needed; i++ {
		m.pool.Put(workers[i%len(workers)])
	}
}

func (m *Manager) replenishLoop() {
	t := time.NewTicker(replenishInterval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			threshold := int(float64(m.pool.Cap()) * replenishThreshold)
			if m.pool.Len() < threshold {
				m.replenish()
			}
		case <-m.done:
			return
		}
	}
}

// heartbeatLoop polls each worker every heartbeatInterval and removes any that
// fail to respond.  This is the "Zombie Cleanup" mechanism described in the
// blueprint (unhealthy workers are evicted within one heartbeat cycle).
func (m *Manager) heartbeatLoop() {
	t := time.NewTicker(heartbeatInterval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			m.mu.RLock()
			workers := make([]worker.Client, len(m.workers))
			copy(workers, m.workers)
			m.mu.RUnlock()

			var alive []worker.Client
			for _, w := range workers {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				_, err := w.Health(ctx)
				cancel()
				if err == nil {
					alive = append(alive, w)
				} else {
					m.log.Warn("worker failed health check — removing from pool",
						zap.String("addr", w.Addr()),
						zap.Error(err),
					)
				}
			}

			m.mu.Lock()
			m.workers = alive
			m.mu.Unlock()

		case <-m.done:
			return
		}
	}
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

// Close stops background goroutines.  In-flight executions are not cancelled.
func (m *Manager) Close() {
	close(m.done)
}

// ── Observability ─────────────────────────────────────────────────────────────

// Stats returns a snapshot of pool and execution counters for the /health
// endpoint and Prometheus metrics.
func (m *Manager) Stats() map[string]any {
	m.mu.RLock()
	workerCount := len(m.workers)
	m.mu.RUnlock()

	return map[string]any{
		"warm_slots":   m.pool.Len(),
		"pool_cap":     m.pool.Cap(),
		"worker_nodes": workerCount,
		"total_execs":  m.totalExecs.Load(),
		"failed_execs": m.failedExecs.Load(),
	}
}
