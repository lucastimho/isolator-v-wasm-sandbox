package api

import (
	"net/http"

	chi "github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.uber.org/zap"

	"github.com/lucasho/isolator-v/orchestrator/internal/middleware"
	"github.com/lucasho/isolator-v/orchestrator/internal/pool"
	"github.com/lucasho/isolator-v/orchestrator/internal/ratelimit"
)

// ServerConfig holds all dependencies required to build the HTTP server.
type ServerConfig struct {
	Manager     *pool.Manager
	TokenBucket *ratelimit.TokenBucket // nil → rate limiting disabled
	JWTSecret   string                 // "" → auth disabled
	Log         *zap.Logger
}

// NewRouter constructs and returns the chi router with all middleware and routes
// wired up.
//
// Route map:
//
//	GET  /health     — liveness probe (no auth)
//	GET  /metrics    — Prometheus metrics (no auth)
//	POST /execute    — run WASM in a sandbox (auth + rate-limited)
func NewRouter(cfg ServerConfig) http.Handler {
	h := NewHandler(cfg.Manager, cfg.Log)

	r := chi.NewRouter()

	// ── Global middleware (applied to every route) ─────────────────────────
	r.Use(chiMiddleware.RealIP)        // normalize RemoteAddr
	r.Use(chiMiddleware.RequestID)     // inject X-Request-Id
	r.Use(chiMiddleware.Recoverer)     // recover from panics → 500
	r.Use(chiMiddleware.Compress(5))   // gzip responses
	r.Use(middleware.Prometheus)       // record latency + request counts

	// ── Public endpoints (no auth, no rate limit) ──────────────────────────
	r.Get("/health", h.Health)
	r.Handle("/metrics", promhttp.Handler())

	// ── Authenticated + rate-limited execution routes ──────────────────────
	r.Group(func(r chi.Router) {
		// JWT auth (no-op when JWTSecret == "").
		r.Use(middleware.JWTAuth(cfg.JWTSecret))

		// Token bucket rate limiting (no-op when TokenBucket == nil).
		if cfg.TokenBucket != nil {
			r.Use(middleware.RateLimit(cfg.TokenBucket, cfg.Log))
		}

		r.Post("/execute", h.Execute)
	})

	return r
}
