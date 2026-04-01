// Isolator-V Orchestration Layer
//
// This binary is the Go Orchestration Layer that sits between the API Gateway
// and the Rust WASM Worker nodes.  It exposes a REST API, manages a Warm Pool
// of worker connections, enforces rate limits, and asynchronously persists VFS
// snapshots to LibSQL/Turso.
//
// Quick start (local dev, Rust worker already running on :3000):
//
//	docker compose up -d          # start Redis
//	go run ./cmd/server           # start orchestrator on :8080
//
// Or with full config:
//
//	cp .env.example .env && $EDITOR .env
//	go run ./cmd/server
package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/lucasho/isolator-v/orchestrator/internal/api"
	"github.com/lucasho/isolator-v/orchestrator/internal/config"
	"github.com/lucasho/isolator-v/orchestrator/internal/middleware"
	"github.com/lucasho/isolator-v/orchestrator/internal/pool"
	"github.com/lucasho/isolator-v/orchestrator/internal/ratelimit"
	vfssync "github.com/lucasho/isolator-v/orchestrator/internal/vfs"
	"github.com/lucasho/isolator-v/orchestrator/internal/worker"
)

func main() {
	// ── Structured logger ──────────────────────────────────────────────────
	log, err := zap.NewProduction()
	if err != nil {
		panic("failed to initialise logger: " + err.Error())
	}
	defer log.Sync() //nolint:errcheck

	// ── Config ─────────────────────────────────────────────────────────────
	cfg := config.Load()

	log.Info("isolator-v orchestrator starting",
		zap.String("port", cfg.Port),
		zap.Strings("workers", cfg.WorkerAddrs),
		zap.String("worker_protocol", cfg.WorkerProtocol),
		zap.Int("pool_capacity", cfg.PoolCapacity),
		zap.Bool("auth_enabled", cfg.JWTSecret != ""),
		zap.Bool("vfs_persistence", cfg.LibSQLURL != ""),
	)

	// ── Worker clients ─────────────────────────────────────────────────────
	// WORKER_PROTOCOL=http  → HTTPWorkerClient (default; no worker binary changes needed)
	// WORKER_PROTOCOL=grpc  → GRPCWorkerClient (requires upgraded Rust worker)
	var clients []worker.Client
	for _, addr := range cfg.WorkerAddrs {
		addr = strings.TrimSpace(addr)
		switch cfg.WorkerProtocol {
		case "grpc":
			c, err := worker.NewGRPCClient(addr, log.Named("grpc"))
			if err != nil {
				log.Fatal("grpc worker dial failed", zap.String("addr", addr), zap.Error(err))
			}
			clients = append(clients, c)
		default: // "http"
			clients = append(clients, worker.NewHTTPClient(addr))
		}
		log.Info("registered worker",
			zap.String("addr", addr),
			zap.String("protocol", cfg.WorkerProtocol),
		)
	}
	if len(clients) == 0 {
		log.Fatal("no worker addresses configured (WORKER_ADDRS)")
	}

	// ── VFS write-behind channel ───────────────────────────────────────────
	// Buffer 1024 snapshots; the sync service drains it every 500ms.
	vfsCh := make(chan *worker.ExecuteResponse, 1024)

	// ── LibSQL write-behind sync ───────────────────────────────────────────
	var sync *vfssync.WriteBehindSync
	if cfg.LibSQLURL != "" {
		sync, err = vfssync.New(vfssync.Config{
			DBURL:         cfg.LibSQLURL,
			FlushInterval: cfg.VFSSyncInterval,
			Ch:            vfsCh,
			Log:           log.Named("vfs"),
		})
		if err != nil {
			log.Fatal("vfs sync init failed", zap.Error(err))
		}
	} else {
		log.Warn("LIBSQL_URL not set — VFS persistence disabled; snapshots will be discarded")
		// Drain the channel so it never backs up when persistence is off.
		go func() {
			for range vfsCh {
			}
		}()
	}

	// ── SandboxManager (warm pool) ─────────────────────────────────────────
	manager := pool.NewManager(pool.ManagerConfig{
		WorkerClients: clients,
		PoolCapacity:  cfg.PoolCapacity,
		ExecTimeout:   cfg.ExecTimeout,
		VFSCh:         vfsCh,
		Log:           log.Named("pool"),
	})
	defer manager.Close()

	// Wire pool stats into the Prometheus gauge.
	middleware.RegisterPoolGauge(func() float64 {
		stats := manager.Stats()
		if v, ok := stats["warm_slots"].(int); ok {
			return float64(v)
		}
		return 0
	})

	// ── Redis + token bucket rate limiter ──────────────────────────────────
	redisOpts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Fatal("invalid REDIS_URL", zap.String("url", cfg.RedisURL), zap.Error(err))
	}
	rdb := redis.NewClient(redisOpts)

	// Verify Redis connectivity at startup (non-fatal: we fail open on errors).
	pingCtx, pingCancel := context.WithTimeout(context.Background(), 3*time.Second)
	if err := rdb.Ping(pingCtx).Err(); err != nil {
		log.Warn("redis ping failed — rate limiting will fail open", zap.Error(err))
	}
	pingCancel()

	tb := ratelimit.New(rdb, cfg.RateLimitRPS, cfg.RateLimitBurst)

	// ── HTTP server ────────────────────────────────────────────────────────
	router := api.NewRouter(api.ServerConfig{
		Manager:     manager,
		TokenBucket: tb,
		JWTSecret:   cfg.JWTSecret,
		Log:         log.Named("api"),
	})

	srv := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: router,
		// Timeouts set tighter than the execution timeout to avoid resource leaks.
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      cfg.ExecTimeout + 5*time.Second,
		IdleTimeout:       60 * time.Second,
	}

	// ── Start ──────────────────────────────────────────────────────────────
	go func() {
		log.Info("orchestrator listening", zap.String("addr", srv.Addr))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal("server error", zap.Error(err))
		}
	}()

	// ── Graceful shutdown ──────────────────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	sig := <-quit

	log.Info("shutdown signal received", zap.String("signal", sig.String()))

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer shutdownCancel()

	// 1. Stop accepting new requests.
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("HTTP server shutdown error", zap.Error(err))
	}

	// 2. Final VFS flush to LibSQL.
	if sync != nil {
		if err := sync.Close(shutdownCtx); err != nil {
			log.Error("vfs sync close error", zap.Error(err))
		}
	}

	// 3. Close the VFS channel so the drain goroutine exits cleanly.
	close(vfsCh)

	log.Info("shutdown complete")
}
