// Package config reads orchestrator configuration from environment variables.
package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all application settings.
type Config struct {
	// HTTP server
	Port string

	// WASM Worker nodes — comma-separated HTTP base URLs.
	// e.g. "http://worker1:3000,http://worker2:3000"
	WorkerAddrs []string

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
}

// Load reads configuration from environment variables, applying sensible
// defaults for every value so the orchestrator runs out of the box for local
// development with just a Rust worker on localhost:3000 and Redis on 6379.
func Load() *Config {
	return &Config{
		Port:            env("PORT", "8080"),
		WorkerAddrs:     splitTrim(env("WORKER_ADDRS", "http://localhost:3000"), ","),
		PoolCapacity:    envInt("POOL_CAPACITY", 50),
		ExecTimeout:     time.Duration(envInt("EXEC_TIMEOUT_MS", 30_000)) * time.Millisecond,
		RedisURL:        env("REDIS_URL", "redis://localhost:6379"),
		RateLimitRPS:    envInt("RATE_LIMIT_RPS", 100),
		RateLimitBurst:  envInt("RATE_LIMIT_BURST", 200),
		JWTSecret:       env("JWT_SECRET", ""),
		LibSQLURL:       env("LIBSQL_URL", ""),
		VFSSyncInterval: time.Duration(envInt("VFS_SYNC_INTERVAL_MS", 500)) * time.Millisecond,
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
