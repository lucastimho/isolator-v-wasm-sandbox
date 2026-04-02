#!/usr/bin/env bash
# wasm-demos/build.sh
#
# Compile all demo programs to wasm32-wasip1, then print their base64 strings
# ready to paste into ExecutionConsole.tsx.
#
# Usage:
#   cd wasm-demos
#   ./build.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="wasm32-wasip1"
RELEASE_DIR="$SCRIPT_DIR/target/$TARGET/release"
NAMES="hello counter fibonacci primes files"

# ── 1. Ensure target is installed ─────────────────────────────────────────────
if ! rustup target list --installed | grep -q "$TARGET"; then
  echo "Installing $TARGET target..."
  rustup target add "$TARGET"
fi

# ── 2. Build ──────────────────────────────────────────────────────────────────
echo "Building wasm-demos (release, $TARGET)..."
cargo build --release --target "$TARGET" --manifest-path "$SCRIPT_DIR/Cargo.toml"
echo ""

# ── 3. Optimise with wasm-opt if available ────────────────────────────────────
# Rust WASI binaries use bulk-memory ops (memory.copy/fill), so we must pass
# --enable-bulk-memory otherwise wasm-opt's validator rejects the input.
if command -v wasm-opt &>/dev/null; then
  echo "Optimising with wasm-opt (-Oz --enable-bulk-memory)..."
  for name in $NAMES; do
    src="$RELEASE_DIR/$name.wasm"
    opt="$RELEASE_DIR/$name.opt.wasm"
    wasm-opt -Oz --strip-debug --enable-bulk-memory "$src" -o "$opt"
    before="$(wc -c < "$src" | tr -d ' ')"
    after="$(wc -c < "$opt" | tr -d ' ')"
    echo "  $name: ${before} → ${after} bytes"
    # Use the optimised binary going forward
    cp "$opt" "$src"
  done
  echo ""
else
  echo "wasm-opt not found — skipping optimisation (brew install binaryen to enable)"
  echo ""
fi

# ── 4. Print sizes and base64 strings ─────────────────────────────────────────
echo "Binary sizes:"
for name in $NAMES; do
  wasm="$RELEASE_DIR/$name.wasm"
  if [[ ! -f "$wasm" ]]; then
    echo "  ERROR: $wasm not found" >&2
    exit 1
  fi
  bytes="$(wc -c < "$wasm" | tr -d ' ')"
  b64="$(base64 -i "$wasm" | tr -d '\n')"
  b64len="${#b64}"
  echo "  $name: $bytes bytes  →  $b64len b64 chars"
done

echo ""
echo "========== Paste these into ExecutionConsole.tsx =========="
echo ""
echo "Search for HELLO_WASM_B64 / COUNTER_WASM_B64 / etc. and replace"
echo "the string content (keep the variable name and const declaration)."
echo ""

for name in $NAMES; do
  wasm="$RELEASE_DIR/$name.wasm"
  b64="$(base64 -i "$wasm" | tr -d '\n')"
  upper="$(echo "$name" | tr '[:lower:]' '[:upper:]')_WASM_B64"

  echo "// ── $name ──"
  echo "const $upper ="

  # Fold into 76-char lines with JS string concat (+), last line gets ";"
  echo "$b64" | fold -w 76 | awk '
    NR > 1 { print "  \"" prev "\" +" }
    { prev = $0 }
    END { print "  \"" prev "\";" }
  '
  echo ""
done
