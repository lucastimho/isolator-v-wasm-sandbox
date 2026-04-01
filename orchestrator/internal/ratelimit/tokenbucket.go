// Package ratelimit implements a Redis-backed Token Bucket algorithm.
//
// Token Bucket recap
//
//	Each client key holds a bucket with `capacity` tokens.
//	Tokens refill at `rate` tokens/second.
//	Each request consumes one token.
//	When the bucket is empty the request is rejected (HTTP 429).
//
// Why Redis?
//
//	A local in-process bucket wouldn't work across multiple orchestrator
//	replicas.  Storing the bucket in Redis gives us a single authoritative
//	counter with atomic check-and-decrement via a Lua script — no race
//	conditions, no double-spending.
//
// Fail-open behaviour
//
//	If Redis is unavailable, Allow() returns (true, err) so the service
//	degrades gracefully rather than blocking all traffic.  Log the error
//	and alert separately.
package ratelimit

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// TokenBucket is a Redis-backed token bucket rate limiter.
type TokenBucket struct {
	rdb      redis.UniversalClient
	rate     int // sustained tokens per second
	capacity int // max burst size
}

// New creates a TokenBucket.
//
//   - ratePerSec: sustained request rate allowed per key.
//   - capacity:   maximum burst (bucket size).  capacity ≥ ratePerSec.
func New(rdb redis.UniversalClient, ratePerSec, capacity int) *TokenBucket {
	return &TokenBucket{rdb: rdb, rate: ratePerSec, capacity: capacity}
}

// luaScript atomically:
//  1. Loads the current token count and last-refill timestamp from a Redis hash.
//  2. Calculates new tokens based on elapsed seconds × rate.
//  3. Clamps to capacity.
//  4. Consumes one token if available and persists the new state.
//  5. Returns 1 (allowed) or 0 (rate-limited).
//
// Using Lua ensures the check-and-decrement is atomic — no WATCH/MULTI needed.
var luaScript = redis.NewScript(`
local key      = KEYS[1]
local now      = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local ttl      = tonumber(ARGV[4])

local data   = redis.call("HMGET", key, "tokens", "last_refill")
local tokens = tonumber(data[1])
local last   = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  last   = now
end

-- Refill based on elapsed time.
local elapsed = math.max(0, now - last)
local refill  = math.floor(elapsed * rate)
tokens        = math.min(capacity, tokens + refill)
last          = now

if tokens < 1 then
  redis.call("HMSET", key, "tokens", tokens, "last_refill", last)
  redis.call("EXPIRE", key, ttl)
  return 0
end

tokens = tokens - 1
redis.call("HMSET", key, "tokens", tokens, "last_refill", last)
redis.call("EXPIRE", key, ttl)
return 1
`)

// Allow checks whether key has a remaining token and consumes it.
//
// Returns:
//   - (true,  nil)  → request is allowed.
//   - (false, nil)  → bucket empty; caller should return HTTP 429.
//   - (true,  err)  → Redis error; fails open (logs the error, allows through).
func (tb *TokenBucket) Allow(ctx context.Context, key string) (bool, error) {
	// Express now as fractional seconds for sub-second refill accuracy.
	now := float64(time.Now().UnixMilli()) / 1000.0

	// TTL for the Redis key: keep it alive for at least one full refill cycle
	// after the bucket would be empty.
	ttlSec := tb.capacity/tb.rate*2 + 10

	result, err := luaScript.Run(ctx, tb.rdb,
		[]string{"rl:" + key},
		fmt.Sprintf("%.6f", now), tb.rate, tb.capacity, ttlSec,
	).Int()
	if err != nil {
		// Fail open: don't block traffic when Redis is down.
		return true, fmt.Errorf("rate limit redis error (failing open): %w", err)
	}

	return result == 1, nil
}
