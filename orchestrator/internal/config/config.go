// Package config reads orchestrator configuration from environment variables,
// with optional .env file support.
package config

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all application settings.
type Config struct {
	// HTTP server
	Port string

	// WASM Worker nodes — comma-separated addresses.
	//   HTTP workers:  "http://worker1:3000,http://worker2:3000"
	//   gRPC workers:  "worker1:50051,worker2:50051"
	WorkerAddrs []string

	// WorkerProtocol selects the transport used to talk to worker nodes.
	//   "http"  — existing Rust REST API (default, no changes to the worker binary)
	//   "grpc"  — sandbox.v1.SandboxService over HTTP/2 (requires upgraded worker)
	WorkerProtocol string

	// Warm Pool
	PoolCapacity int

	// Per-request execution hard deadline.
	ExecTimeout time.Duration

	// Redis connection URL.  Used by the rate limiter.
	RedisURL string

	// Rate limiting (token bucket per client IP).
	RateLimitRPS   int
	RateLimitBurst int

	// JWT_SECRET="" disables authentication (dev mode).
	JWTSecret string

	// LibSQL / Turso.  Empty string disables VFS persistence.
	LibSQLURL string

	// How often to flush buffered VFS changes to the database.
	VFSSyncInterval time.Duration

	// LogLevel controls zap verbosity: "debug", "info", "warn", "error".
	// Set LOG_LEVEL=debug to see per-stage execution traces.
	LogLevel string
}

// loadDotEnv reads KEY=VALUE pairs from a .env file and sets them as
// environment variables, but only for keys that are not already set.
// Blank lines and lines starting with # are ignored.
// The file is looked up relative to the current working directory, so it
// works correctly when you run `go run ./cmd/server` from the orchestrator
// root as well as when running a compiled binary from the same directory.
func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return // .env is optional — silently skip if missing
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.IndexByte(line, '=')
		if idx < 1 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		val := strings.TrimSpace(line[idx+1:])
		// Strip inline comments (e.g. RATE_LIMIT_RPS=100  # comment)
		if ci := strings.IndexByte(val, '#'); ci >= 0 {
			val = strings.TrimSpace(val[:ci])
		}
		// Strip matching outer quotes (" or ')
		if len(val) >= 2 {
			if (val[0] == '"' && val[len(val)-1] == '"') ||
				(val[0] == '\'' && val[len(val)-1] == '\'') {
				val = val[1 : len(val)-1]
			}
		}
		// Only set if not already provided by the real environment.
		if os.Getenv(key) == "" {
			_ = os.Setenv(key, val)
		}
	}
}

// Load reads configuration from environment variables, applying sensible
// defaults for every value so the orchestrator runs out of the box for local
// development.  A .env file in the working directory is loaded first so that
// `cp .env.example .env && $EDITOR .env && go run ./cmd/server` works
// without manually exporting variables.
func Load() *Config {
	loadDotEnv(".env")
	return &Config{
		Port:            env("PORT", "8080"),
		WorkerAddrs:     splitTrim(env("WORKER_ADDRS", "http://localhost:3000"), ","),
		WorkerProtocol:  env("WORKER_PROTOCOL", "http"),
		PoolCapacity:    envInt("POOL_CAPACITY", 50),
		ExecTimeout:     time.Duration(envInt("EXEC_TIMEOUT_MS", 30_000)) * time.Millisecond,
		RedisURL:        env("REDIS_URL", "redis://localhost:6379"),
		RateLimitRPS:    envInt("RATE_LIMIT_RPS", 100),
		RateLimitBurst:  envInt("RATE_LIMIT_BURST", 200),
		JWTSecret:       env("JWT_SECRET", ""),
		LibSQLURL:       env("LIBSQL_URL", ""),
		VFSSyncInterval: time.Duration(envInt("VFS_SYNC_INTERVAL_MS", 500)) * time.Millisecond,
		LogLevel:        env("LOG_LEVEL", "info"),
	}
}

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return def
}

func splitTrim(s, sep string) []string {
	parts := strings.Split(s, sep)
	result := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			result = append(result, t)
		}
	}
	return result
}
