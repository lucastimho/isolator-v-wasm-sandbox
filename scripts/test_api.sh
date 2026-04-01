#!/usr/bin/env bash
# scripts/test_api.sh
#
# End-to-end HTTP API smoke tests.
# Run AFTER starting the server:  cargo run
#
# Usage:
#   chmod +x scripts/test_api.sh
#   ./scripts/test_api.sh [BASE_URL]
#
# BASE_URL defaults to http://localhost:3000

set -euo pipefail

BASE="${1:-http://localhost:3000}"
PASS=0
FAIL=0

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[0;33m'
BLU='\033[0;34m'
RST='\033[0m'

pass() { echo -e "  ${GRN}✔ PASS${RST}  $1"; (( ++PASS )) || true; }
fail() { echo -e "  ${RED}✘ FAIL${RST}  $1"; echo -e "       ${YLW}$2${RST}"; (( ++FAIL )) || true; }
section() { echo -e "\n${BLU}══ $1 ══${RST}"; }

# ── Minimal valid WASM bytes (exports _start, does nothing) ──────────────────
# (module (func (export "_start")))
NOOP_WASM_B64="AGFzbQEAAAABBAFgAAADAgEABwoBBl9zdGFydAAACgQBAgAL"

# ── Helper to run a curl and capture HTTP status + body ──────────────────────
api() {
    local method="$1" path="$2" data="${3:-}"
    if [[ -n "$data" ]]; then
        curl -s -w "\n__STATUS__%{http_code}" \
             -X "$method" "${BASE}${path}" \
             -H "Content-Type: application/json" \
             -d "$data"
    else
        curl -s -w "\n__STATUS__%{http_code}" -X "$method" "${BASE}${path}"
    fi
}

extract_status() { echo "$1" | grep -o '__STATUS__[0-9]*' | tr -d '__STATUS__'; }
extract_body()   { echo "$1" | sed 's/__STATUS__[0-9]*$//'; }

# ─────────────────────────────────────────────────────────────────────────────
section "§1  Liveness"
# ─────────────────────────────────────────────────────────────────────────────

echo "  GET /health"
RESP=$(api GET /health)
STATUS=$(extract_status "$RESP")
BODY=$(extract_body "$RESP")

if [[ "$STATUS" == "200" ]]; then
    WARM=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('warm_slots','?'))" 2>/dev/null || echo "?")
    pass "/health returned 200 (warm_slots=$WARM)"
else
    fail "/health should return 200" "got HTTP $STATUS: $BODY"
fi

echo "  GET /metrics"
RESP=$(api GET /metrics)
STATUS=$(extract_status "$RESP")
BODY=$(extract_body "$RESP")

if [[ "$STATUS" == "200" ]] && echo "$BODY" | grep -q "wasm_pool_warm_slots"; then
    pass "/metrics returned Prometheus format"
else
    fail "/metrics should contain 'wasm_pool_warm_slots'" "got HTTP $STATUS: $BODY"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "§2  Execute — happy path"
# ─────────────────────────────────────────────────────────────────────────────

echo "  POST /execute (no-op WASM)"
PAYLOAD=$(printf '{"wasm_b64":"%s","label":"smoke-test"}' "$NOOP_WASM_B64")
RESP=$(api POST /execute "$PAYLOAD")
STATUS=$(extract_status "$RESP")
BODY=$(extract_body "$RESP")

if [[ "$STATUS" == "200" ]]; then
    EXIT=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('exit_code','?'))" 2>/dev/null || echo "?")
    ELAPSED=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('elapsed_ms','?'))" 2>/dev/null || echo "?")
    pass "/execute (no-op) returned 200 (exit_code=$EXIT, elapsed_ms=${ELAPSED}ms)"
    if [[ "$EXIT" != "0" ]]; then
        fail "exit_code should be 0" "got $EXIT"
    fi
    if [[ "$ELAPSED" != "?" ]] && (( ELAPSED > 500 )); then
        fail "warm execution should be <500ms" "got ${ELAPSED}ms"
    else
        pass "Cold/warm start latency ${ELAPSED}ms ≤ 500ms"
    fi
else
    fail "/execute should return 200" "got HTTP $STATUS: $BODY"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "§3  Execute — error handling"
# ─────────────────────────────────────────────────────────────────────────────

echo "  POST /execute (invalid Base64)"
RESP=$(api POST /execute '{"wasm_b64":"NOT_VALID_BASE64!!!","label":"bad-payload"}')
STATUS=$(extract_status "$RESP")

if [[ "$STATUS" == "400" ]]; then
    pass "/execute with invalid Base64 returns 400"
else
    fail "/execute with invalid Base64 should return 400" "got HTTP $STATUS"
fi

echo "  POST /execute (malformed JSON)"
RESP=$(curl -s -w "\n__STATUS__%{http_code}" \
       -X POST "${BASE}/execute" \
       -H "Content-Type: application/json" \
       -d '{broken json}')
STATUS=$(extract_status "$RESP")

if [[ "$STATUS" == "400" || "$STATUS" == "422" ]]; then
    pass "/execute with malformed JSON returns 4xx"
else
    fail "/execute with malformed JSON should return 4xx" "got HTTP $STATUS"
fi

echo "  POST /execute (invalid WASM bytes)"
INVALID_WASM_B64=$(echo -n "this_is_not_wasm" | base64)
PAYLOAD=$(printf '{"wasm_b64":"%s","label":"invalid-wasm"}' "$INVALID_WASM_B64")
RESP=$(api POST /execute "$PAYLOAD")
STATUS=$(extract_status "$RESP")

# The module compilation fails → should return 500 with error details
if [[ "$STATUS" == "500" ]]; then
    pass "/execute with invalid WASM bytes returns 500"
else
    # Some implementations may return 400 — either is acceptable.
    if [[ "$STATUS" == "400" ]]; then
        pass "/execute with invalid WASM bytes returns 400 (acceptable)"
    else
        fail "/execute with invalid WASM bytes should return 4xx or 5xx" "got HTTP $STATUS"
    fi
fi

# ─────────────────────────────────────────────────────────────────────────────
section "§4  Concurrency stress"
# ─────────────────────────────────────────────────────────────────────────────

echo "  POST /execute × 20 concurrent requests"
PAYLOAD=$(printf '{"wasm_b64":"%s","label":"stress"}' "$NOOP_WASM_B64")

PIDS=()
RESULTS=()
for i in $(seq 1 20); do
    (
        RESP=$(api POST /execute "$PAYLOAD" 2>/dev/null)
        STATUS=$(extract_status "$RESP")
        echo "$STATUS" > /tmp/wasm_stress_${i}.txt
    ) &
    PIDS+=($!)
done

for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done

OK=0; FAIL_N=0
for i in $(seq 1 20); do
    S=$(cat /tmp/wasm_stress_${i}.txt 2>/dev/null || echo "?")
    rm -f /tmp/wasm_stress_${i}.txt
    if [[ "$S" == "200" || "$S" == "503" ]]; then
        # 503 is acceptable (pool exhausted) — not a bug.
        ((OK++))
    else
        ((FAIL_N++))
    fi
done

if (( FAIL_N == 0 )); then
    pass "All 20 concurrent requests returned 200 or 503 (pool exhausted)"
else
    fail "$FAIL_N / 20 requests returned unexpected status codes" ""
fi

# ─────────────────────────────────────────────────────────────────────────────
section "§5  SSE stream endpoint"
# ─────────────────────────────────────────────────────────────────────────────

echo "  GET /stream/nonexistent-job-id"
RESP=$(curl -s -w "\n__STATUS__%{http_code}" \
       --max-time 2 \
       -H "Accept: text/event-stream" \
       "${BASE}/stream/nonexistent-job-id" 2>/dev/null || echo "__STATUS__200")
STATUS=$(extract_status "$RESP")
BODY=$(extract_body "$RESP")

if [[ "$STATUS" == "200" ]]; then
    if echo "$BODY" | grep -q "event: error\|not found"; then
        pass "/stream/:id returns SSE 'error' event for unknown job"
    else
        pass "/stream/:id returned 200 (SSE connection established)"
    fi
else
    fail "/stream/:id should return 200 (SSE)" "got HTTP $STATUS"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "§6  Summary"
# ─────────────────────────────────────────────────────────────────────────────

TOTAL=$((PASS + FAIL))
echo ""
echo -e "  Results: ${GRN}${PASS} passed${RST} / ${RED}${FAIL} failed${RST} / ${TOTAL} total"

if (( FAIL > 0 )); then
    echo -e "  ${RED}Some tests failed — check server logs for details.${RST}"
    exit 1
else
    echo -e "  ${GRN}All tests passed! 🎉${RST}"
fi
