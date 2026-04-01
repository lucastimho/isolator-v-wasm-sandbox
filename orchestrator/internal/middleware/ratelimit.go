package middleware

import (
	"net"
	"net/http"
	"strings"

	"go.uber.org/zap"

	"github.com/lucasho/isolator-v/orchestrator/internal/ratelimit"
)

// RateLimit enforces per-client-IP token bucket rate limiting.
// Clients behind a reverse proxy are identified by X-Forwarded-For.
// When the bucket is empty the handler returns HTTP 429 with Retry-After: 1.
func RateLimit(tb *ratelimit.TokenBucket, log *zap.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIP(r)

			allowed, err := tb.Allow(r.Context(), ip)
			if err != nil {
				// Redis error: already fails open inside TokenBucket.Allow(), but
				// log here for alerting.
				log.Warn("rate limit check error (failing open)",
					zap.String("ip", ip),
					zap.Error(err),
				)
			}

			if !allowed {
				w.Header().Set("Retry-After", "1")
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				//nolint:errcheck
				w.Write([]byte(`{"error":"rate limit exceeded","code":"RATE_LIMITED"}`))
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// clientIP extracts the real client IP, preferring X-Forwarded-For.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// XFF can be "client, proxy1, proxy2" — take the leftmost entry.
		if ip := strings.TrimSpace(strings.Split(xff, ",")[0]); ip != "" {
			return ip
		}
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return ip
}
