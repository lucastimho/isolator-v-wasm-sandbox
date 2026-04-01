// Package worker defines the interface between the orchestrator and any WASM
// worker node, plus the types shared by all transport implementations.
//
// Current concrete implementations:
//   - HTTPWorkerClient  — bridges the existing Rust wasm-worker-manager REST API.
//
// Future:
//   - GRPCWorkerClient  — generated from proto/sandbox/v1/sandbox.proto once
//                          the Rust worker exposes a gRPC server.
//
// Swapping transports requires only changing the factory in main.go; the pool
// and all middleware are transport-agnostic.
package worker

import (
	"context"
	"time"
)

// ExecuteRequest is the canonical input for a sandbox execution.
type ExecuteRequest struct {
	WASMBytes []byte
	Label     string
	SessionID string
	Timeout   time.Duration // 0 → use worker default
}

// ExecuteResponse is the canonical result of a sandbox execution.
type ExecuteResponse struct {
	SandboxID   string
	Stdout      []byte
	Stderr      []byte
	ExitCode    int32
	ElapsedMS   uint64
	VFSSnapshot map[string][]byte
}

// HealthStatus reports whether a worker is alive and how many warm slots it has.
type HealthStatus struct {
	Healthy   bool
	WarmSlots int
	Addr      string
}

// Client abstracts transport-level communication with a single WASM worker node.
// Implementations must be safe for concurrent use from multiple goroutines.
type Client interface {
	// Execute submits a WASM binary for sandboxed execution.
	Execute(ctx context.Context, req *ExecuteRequest) (*ExecuteResponse, error)

	// Health returns liveness and warm-slot availability for this worker.
	Health(ctx context.Context) (*HealthStatus, error)

	// Addr returns the network address of the worker (for logging/metrics).
	Addr() string

	// Close releases any held resources (connections, goroutines).
	Close() error
}
