// Package middleware contains HTTP middleware for the orchestrator API.
package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

type contextKey string

const claimsKey contextKey = "jwt_claims"

// JWTAuth returns a middleware that validates Bearer tokens signed with secret.
// Requests without a valid, non-expired token receive HTTP 401.
//
// Set secret="" to disable auth (useful in local development when JWT_SECRET
// is not configured).
func JWTAuth(secret string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Auth disabled — pass through.
			if secret == "" {
				next.ServeHTTP(w, r)
				return
			}

			auth := r.Header.Get("Authorization")
			if !strings.HasPrefix(auth, "Bearer ") {
				jsonErr(w, "missing or malformed Authorization header", http.StatusUnauthorized)
				return
			}

			tokenStr := strings.TrimPrefix(auth, "Bearer ")
			token, err := jwt.Parse(tokenStr,
				func(t *jwt.Token) (any, error) {
					if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
						return nil, jwt.ErrSignatureInvalid
					}
					return []byte(secret), nil
				},
				jwt.WithExpirationRequired(),
			)
			if err != nil || !token.Valid {
				jsonErr(w, "invalid or expired token", http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), claimsKey, token.Claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// Claims extracts JWT claims from the request context (set by JWTAuth).
// Returns nil if auth is disabled or the context has no claims.
func Claims(r *http.Request) jwt.Claims {
	if c, ok := r.Context().Value(claimsKey).(jwt.Claims); ok {
		return c
	}
	return nil
}

func jsonErr(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	//nolint:errcheck
	w.Write([]byte(`{"error":"` + msg + `"}`))
}
