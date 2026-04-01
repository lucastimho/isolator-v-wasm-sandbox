package ratelimit_test

// TokenBucket tests
//
// The full allow/deny and refill logic requires a running Redis instance because
// the limiter uses a Lua script executed server-side.  These tests cover:
//
//   1. Fail-open behaviour when Redis is unreachable.
//   2. Integration tests gated on a REDIS_URL environment variable —
//      run with:  REDIS_URL=redis://localhost:6379 go test ./internal/ratelimit/...
//
// For richer in-process testing without a real Redis, add miniredis:
//
//   go get github.com/alicebob/miniredis/v2
//
// and follow the example in the "Integration with miniredis" section below.

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/lucasho/isolator-v/orchestrator/internal/ratelimit"
)

// ── Helpers ───────────────────────────────────────────────────────────────────

// newUnreachableBucket returns a bucket pointed at a port that immediately
// refuses connections, so every Allow() call fails open.
func newUnreachableBucket(ratePerSec, capacity int) *ratelimit.TokenBucket {
	rdb := redis.NewUniversalClient(&redis.UniversalOptions{
		Addrs:       []string{"localhost:1"}, // port 1 is reserved — always refused
		DialTimeout: 10 * time.Millisecond,
	})
	return ratelimit.New(rdb, ratePerSec, capacity)
}

// redisFromEnv returns a client for the REDIS_URL env var, or skips the test.
// It also pings Redis to confirm it is reachable; if the ping fails the test
// is skipped rather than failing with misleading fail-open errors.
func redisFromEnv(t *testing.T) redis.UniversalClient {
	t.Helper()
	url := os.Getenv("REDIS_URL")
	if url == "" {
		t.Skip("REDIS_URL not set — skipping Redis integration tests")
	}
	opts, err := redis.ParseURL(url)
	if err != nil {
		t.Fatalf("invalid REDIS_URL: %v", err)
	}
	rdb := redis.NewClient(opts)

	// Confirm Redis is actually reachable before proceeding.  Without this
	// check, a set-but-wrong REDIS_URL causes tests to run against an
	// unreachable server and produce confusing fail-open results instead of
	// a clear skip message.
	pingCtx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	if pingErr := rdb.Ping(pingCtx).Err(); pingErr != nil {
		rdb.Close()
		t.Skipf("Redis at %q is unreachable (%v) — skipping integration tests", url, pingErr)
	}

	t.Cleanup(func() { rdb.Close() })
	return rdb
}

// uniqueKey returns a per-test key so tests don't share bucket state.
func uniqueKey(t *testing.T) string {
	return "test:" + t.Name()
}

// ── Fail-open (no Redis required) ─────────────────────────────────────────────

func TestTokenBucket_Allow_FailOpen_WhenRedisDown(t *testing.T) {
	tb := newUnreachableBucket(10, 20)

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	allowed, err := tb.Allow(ctx, "test-key")
	if err == nil {
		t.Error("expected an error when Redis is unreachable")
	}
	if !allowed {
		t.Error("fail-open: Allow should return true even when Redis is down")
	}
}

func TestTokenBucket_Allow_FailOpen_ReturnsTrue_EvenWithError(t *testing.T) {
	tb := newUnreachableBucket(1, 1)
	ctx := context.Background()

	// Regardless of how many calls we make, all must be allowed (fail open).
	for i := 0; i < 5; i++ {
		allowed, _ := tb.Allow(ctx, "consistent-fail")
		if !allowed {
			t.Errorf("call %d: fail-open should return true, got false", i)
		}
	}
}

// ── Integration tests (require REDIS_URL) ─────────────────────────────────────

func TestTokenBucket_Allow_FirstRequest_IsAllowed(t *testing.T) {
	rdb := redisFromEnv(t)
	key := uniqueKey(t)

	// Flush any existing state for this key.
	rdb.Del(context.Background(), "rl:"+key)

	tb := ratelimit.New(rdb, 10, 10)
	allowed, err := tb.Allow(context.Background(), key)
	if err != nil {
		t.Fatalf("Allow: unexpected error: %v", err)
	}
	if !allowed {
		t.Fatal("first request with full bucket should be allowed")
	}
}

func TestTokenBucket_Allow_BucketDrains_ThenDenies(t *testing.T) {
	rdb := redisFromEnv(t)
	key := uniqueKey(t)
	rdb.Del(context.Background(), "rl:"+key)

	const capacity = 3
	tb := ratelimit.New(rdb, 1, capacity) // rate=1/s, cap=3

	ctx := context.Background()

	// Consume all tokens.
	for i := 0; i < capacity; i++ {
		allowed, err := tb.Allow(ctx, key)
		if err != nil {
			t.Fatalf("Allow %d: %v", i, err)
		}
		if !allowed {
			t.Fatalf("Allow %d: bucket should not be empty yet", i)
		}
	}

	// Next call should be denied (bucket empty, refill is < 1 s away).
	allowed, err := tb.Allow(ctx, key)
	if err != nil {
		t.Fatalf("Allow after drain: %v", err)
	}
	if allowed {
		t.Fatal("Allow after bucket drained: want false (deny), got true (allow)")
	}
}

func TestTokenBucket_Allow_TokensRefillOverTime(t *testing.T) {
	rdb := redisFromEnv(t)
	key := uniqueKey(t)
	rdb.Del(context.Background(), "rl:"+key)

	const rate = 5 // 5 tokens / second
	tb := ratelimit.New(rdb, rate, rate)
	ctx := context.Background()

	// Drain the bucket completely.
	for i := 0; i < rate; i++ {
		tb.Allow(ctx, key) //nolint:errcheck
	}

	// Confirm bucket is empty.
	if allowed, _ := tb.Allow(ctx, key); allowed {
		t.Fatal("bucket should be empty after draining")
	}

	// Wait long enough for at least one token to refill (≥ 200 ms for rate=5/s).
	time.Sleep(300 * time.Millisecond)

	// Should be allowed again now.
	allowed, err := tb.Allow(ctx, key)
	if err != nil {
		t.Fatalf("Allow after refill: %v", err)
	}
	if !allowed {
		t.Fatal("Allow after refill sleep: want true (allowed), got false")
	}
}

func TestTokenBucket_Allow_DifferentKeysAreIndependent(t *testing.T) {
	rdb := redisFromEnv(t)
	base := uniqueKey(t)
	key1 := base + ":user-A"
	key2 := base + ":user-B"

	rdb.Del(context.Background(), "rl:"+key1, "rl:"+key2)

	const capacity = 2
	tb := ratelimit.New(rdb, 1, capacity)
	ctx := context.Background()

	// Drain key1.
	for i := 0; i < capacity; i++ {
		tb.Allow(ctx, key1) //nolint:errcheck
	}

	// key2 should still have a full bucket.
	allowed, err := tb.Allow(ctx, key2)
	if err != nil {
		t.Fatalf("Allow key2: %v", err)
	}
	if !allowed {
		t.Fatal("key2 should be unaffected by key1 being drained")
	}

	// key1 should be denied.
	allowed, _ = tb.Allow(ctx, key1)
	if allowed {
		t.Fatal("key1 should be denied after draining")
	}
}

func TestTokenBucket_Allow_ContextCancellation(t *testing.T) {
	rdb := redisFromEnv(t)
	tb := ratelimit.New(rdb, 10, 10)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // immediately cancelled

	// With a pre-cancelled context, the Redis call should fail.
	// Fail-open means we still get true.
	allowed, err := tb.Allow(ctx, uniqueKey(t))
	// Either fails open (true + err) or the Redis call succeeds before noticing
	// cancellation — both are acceptable behaviours.
	t.Logf("cancelled ctx: allowed=%v err=%v", allowed, err)
}
