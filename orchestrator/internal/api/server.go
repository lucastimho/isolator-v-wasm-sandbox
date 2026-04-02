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
	VFS         VFSStore               // nil → VFS endpoints return 503
	TokenBucket *ratelimit.TokenBucket // nil → rate limiting disabled
	JWTSecret   string                 // "" → auth disabled
	Log         *zap.Logger
}

// NewRouter constructs and returns the chi router with all middleware and routes
// wired up.
//
// Route map:
//
//	GET  /health                    — liveness probe (no auth)
//	GET  /metrics                   — Prometheus metrics (no auth)
//	POST /execute                   — run WASM in a sandbox (auth + rate-limited)
//	GET  /ws/execute                — WebSocket streaming execution (auth)
//	GET  /vitals/{sessionId}        — per-session resource metrics (auth)
//	GET  /vfs/{sessionId}           — list VFS files for session (auth)
//	GET  /vfs/{sessionId}/file      — fetch a single VFS file (auth)
func NewRouter(cfg ServerConfig) http.Handler {
	h := NewHandler(cfg.Manager, cfg.VFS, cfg.Log)

	r := chi.NewRouter()

	// ── Global middleware (applied to every route) ─────────────────────────
	r.Use(chiMiddleware.RealIP)    // normalize RemoteAddr
	r.Use(chiMiddleware.RequestID) // inject X-Request-Id
	r.Use(chiMiddleware.Recoverer) // recover from panics → 500
	r.Use(middleware.Prometheus)   // record latency + request counts
	// NOTE: Compress is NOT applied globally — it wraps http.ResponseWriter
	// in a gzip writer that does not implement http.Hijacker.  The WebSocket
	// upgrade (nhooyr.io/websocket.Accept) calls ResponseWriter.(http.Hijacker)
	// and panics with "does not implement http.Hijacker" when the middleware is
	// present.  Compression is instead applied only to the non-WebSocket routes.

	// ── Public endpoints (no auth, no rate limit) ──────────────────────────
	r.Group(func(r chi.Router) {
		r.Use(chiMiddleware.Compress(5))
		r.Get("/health", h.Health)
		r.Handle("/metrics", promhttp.Handler())
	})

	// ── Authenticated + rate-limited execution routes ──────────────────────
	r.Group(func(r chi.Router) {
		// JWT auth (no-op when JWTSecret == "").
		r.Use(middleware.JWTAuth(cfg.JWTSecret))

		// Token bucket rate limiting (no-op when TokenBucket == nil).
		if cfg.TokenBucket != nil {
			r.Use(middleware.RateLimit(cfg.TokenBucket, cfg.Log))
		}

		// WebSocket streaming execution — must have NO Compress middleware.
		// chiMiddleware.Compress wraps http.ResponseWriter and drops the
		// http.Hijacker interface that nhooyr.io/websocket needs to perform
		// the HTTP → WebSocket protocol upgrade.
		r.Get("/ws/execute", h.WSExecute)

		// All other authenticated routes — safe to compress.
		r.Group(func(r chi.Router) {
			r.Use(chiMiddleware.Compress(5))

			r.Post("/execute", h.Execute)

			// Per-session observability.
			r.Get("/vitals/{sessionId}", h.Vitals)

			// VFS read endpoints.
			r.Get("/vfs/{sessionId}", h.VFSList)
			r.Get("/vfs/{sessionId}/file", h.VFSFile)
		})
	})

	return r
}
