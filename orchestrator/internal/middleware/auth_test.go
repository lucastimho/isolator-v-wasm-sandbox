package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/lucasho/isolator-v/orchestrator/internal/middleware"
)

const testSecret = "REDACTED"

// makeToken creates a signed HS256 JWT with the given expiry offset.
// A negative duration produces an already-expired token.
func makeToken(t *testing.T, secret string, expiresIn time.Duration) string {
	t.Helper()
	claims := jwt.RegisteredClaims{
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(expiresIn)),
		IssuedAt:  jwt.NewNumericDate(time.Now()),
		Subject:   "user-123",
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := tok.SignedString([]byte(secret))
	if err != nil {
		t.Fatalf("makeToken: %v", err)
	}
	return signed
}

// okHandler is a simple HTTP handler that records whether it was called.
func okHandler(called *bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*called = true
		w.WriteHeader(http.StatusOK)
	})
}

// doRequest runs a single GET through the middleware and returns the status code.
func doRequest(t *testing.T, handler http.Handler, authHeader string) int {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec.Code
}

// ── JWTAuth tests ─────────────────────────────────────────────────────────────

func TestJWTAuth_EmptySecret_DisablesAuth(t *testing.T) {
	var called bool
	h := middleware.JWTAuth("")(okHandler(&called))

	code := doRequest(t, h, "")
	if code != http.StatusOK {
		t.Fatalf("disabled auth: want 200, got %d", code)
	}
	if !called {
		t.Fatal("inner handler not called when auth is disabled")
	}
}

func TestJWTAuth_EmptySecret_PassesRequestsWithoutHeader(t *testing.T) {
	var called bool
	h := middleware.JWTAuth("")(okHandler(&called))

	code := doRequest(t, h, "") // no Authorization header
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d", code)
	}
}

func TestJWTAuth_ValidToken_PassesThrough(t *testing.T) {
	var called bool
	h := middleware.JWTAuth(testSecret)(okHandler(&called))

	token := makeToken(t, testSecret, time.Hour)
	code := doRequest(t, h, "Bearer "+token)
	if code != http.StatusOK {
		t.Fatalf("valid token: want 200, got %d", code)
	}
	if !called {
		t.Fatal("inner handler not called for valid token")
	}
}

func TestJWTAuth_MissingAuthHeader_Returns401(t *testing.T) {
	h := middleware.JWTAuth(testSecret)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("inner handler called despite missing auth header")
	}))

	code := doRequest(t, h, "")
	if code != http.StatusUnauthorized {
		t.Fatalf("missing header: want 401, got %d", code)
	}
}

func TestJWTAuth_MalformedHeader_NoBearerPrefix_Returns401(t *testing.T) {
	h := middleware.JWTAuth(testSecret)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("inner handler called despite malformed header")
	}))

	code := doRequest(t, h, "Token abc123") // wrong scheme
	if code != http.StatusUnauthorized {
		t.Fatalf("malformed header: want 401, got %d", code)
	}
}

func TestJWTAuth_GarbageToken_Returns401(t *testing.T) {
	h := middleware.JWTAuth(testSecret)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("inner handler called for garbage token")
	}))

	code := doRequest(t, h, "Bearer not.a.jwt")
	if code != http.StatusUnauthorized {
		t.Fatalf("garbage token: want 401, got %d", code)
	}
}

func TestJWTAuth_ExpiredToken_Returns401(t *testing.T) {
	h := middleware.JWTAuth(testSecret)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("inner handler called for expired token")
	}))

	token := makeToken(t, testSecret, -time.Minute) // expired 1 minute ago
	code := doRequest(t, h, "Bearer "+token)
	if code != http.StatusUnauthorized {
		t.Fatalf("expired token: want 401, got %d", code)
	}
}

func TestJWTAuth_WrongSecret_Returns401(t *testing.T) {
	h := middleware.JWTAuth(testSecret)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("inner handler called for token with wrong secret")
	}))

	token := makeToken(t, "different-secret", time.Hour)
	code := doRequest(t, h, "Bearer "+token)
	if code != http.StatusUnauthorized {
		t.Fatalf("wrong secret: want 401, got %d", code)
	}
}

func TestJWTAuth_NonHMACAlgorithm_Returns401(t *testing.T) {
	// Sign a token with RS256 — the middleware only accepts HMAC methods.
	h := middleware.JWTAuth(testSecret)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("inner handler called for non-HMAC algorithm token")
	}))

	// We can't easily sign RS256 without a key pair, so craft a hand-rolled
	// header.payload token with alg=none (unsigned) to exercise the alg check.
	// jwt library rejects alg:none by default; supply a garbage signature.
	noneToken := "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0" + // {"alg":"none","typ":"JWT"}
		".eyJzdWIiOiJ1c2VyIiwiZXhwIjo5OTk5OTk5OTk5fQ" + // {"sub":"user","exp":9999999999}
		"." // no signature
	code := doRequest(t, h, "Bearer "+noneToken)
	if code != http.StatusUnauthorized {
		t.Fatalf("alg:none token: want 401, got %d", code)
	}
}

// ── Claims tests ──────────────────────────────────────────────────────────────

func TestClaims_ReturnsNilWhenAuthDisabled(t *testing.T) {
	// When secret is empty, JWTAuth doesn't set claims in the context.
	var claims jwt.Claims
	h := middleware.JWTAuth("")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims = middleware.Claims(r)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	h.ServeHTTP(httptest.NewRecorder(), req)

	if claims != nil {
		t.Errorf("Claims with disabled auth: want nil, got %v", claims)
	}
}

func TestClaims_ReturnsClaimsForValidToken(t *testing.T) {
	var claims jwt.Claims
	h := middleware.JWTAuth(testSecret)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims = middleware.Claims(r)
	}))

	token := makeToken(t, testSecret, time.Hour)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(httptest.NewRecorder(), req)

	if claims == nil {
		t.Fatal("Claims: want jwt.Claims in context, got nil")
	}
}
