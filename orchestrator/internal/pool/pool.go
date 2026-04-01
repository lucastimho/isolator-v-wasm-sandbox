// Package pool implements the Warm Pool and SandboxManager that sit at the
// heart of the Orchestration Layer.
//
// Design
//
//	┌─────────────────────────────────────────────────────────┐
//	│  SandboxManager                                         │
//	│                                                         │
//	│  ┌──────────────────────────────┐                       │
//	│  │  WarmPool  (buffered chan)    │ ← replenishLoop()    │
//	│  │  [client][client][client]... │                       │
//	│  └──────────────────────────────┘                       │
//	│         ↓ Get()                  ↑ Put()                │
//	│  Execute() → worker.Client.Execute() → result           │
//	│                    ↓                                     │
//	│              vfsCh (write-behind)                       │
//	└─────────────────────────────────────────────────────────┘
//
// The WarmPool is a bounded channel of worker.Client values.  Because worker
// connections are cheap (HTTP keep-alive), a single Client object can be
// reused across requests; the pool simply controls concurrency (max N
// in-flight executions) while distributing load across all known worker nodes.
package pool

import (
	"context"
	"errors"

	"github.com/lucasho/isolator-v/orchestrator/internal/worker"
)

// ErrPoolExhausted is returned when no worker slot becomes available before
// the acquire timeout expires.
var ErrPoolExhausted = errors.New("warm pool exhausted: no worker slot available")

// WarmPool is a thread-safe, bounded queue of ready worker.Client connections.
// Get blocks until a client is available or ctx is cancelled.
// Put returns a client to the pool (dropped if the pool is already full).
type WarmPool struct {
	slots chan worker.Client
}

// NewWarmPool creates a pool with the given maximum capacity.
func NewWarmPool(capacity int) *WarmPool {
	return &WarmPool{slots: make(chan worker.Client, capacity)}
}

// Put returns a client to the pool.  If the pool is full (shouldn't happen in
// normal operation) the client is silently discarded.
func (p *WarmPool) Put(c worker.Client) {
	select {
	case p.slots <- c:
	default:
	}
}

// Get acquires a client from the pool, blocking until ctx is cancelled or a
// client is available.
func (p *WarmPool) Get(ctx context.Context) (worker.Client, error) {
	select {
	case c := <-p.slots:
		return c, nil
	case <-ctx.Done():
		return nil, ErrPoolExhausted
	}
}

// Len returns the number of immediately available (idle) slots.
func (p *WarmPool) Len() int { return len(p.slots) }

// Cap returns the total pool capacity.
func (p *WarmPool) Cap() int { return cap(p.slots) }
