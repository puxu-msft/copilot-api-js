#!/usr/bin/env bash
set -u

ROOT=/home/xp/src/copilot-api-js/exp/curl-transport-exe
LOG="$ROOT/oracle.log"
node "$ROOT/oracle.mjs" >"$LOG" 2>&1 &
ORACLE_PID=$!
cleanup() {
  kill -TERM "$ORACLE_PID" 2>/dev/null || true
  wait "$ORACLE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
for _ in $(seq 1 50); do
  rg -q '"ready":true' "$LOG" 2>/dev/null && break
  sleep 0.1
done
rg -q '"ready":true' "$LOG" || { printf 'oracle failed to start\n' >&2; exit 1; }

bun "$ROOT/probe-local.ts" headers | tee "$ROOT/output-headers.jsonl"
bun "$ROOT/probe-local.ts" trailers | tee "$ROOT/output-trailers.jsonl"
bun "$ROOT/probe-local.ts" truncation | tee "$ROOT/output-truncation.jsonl"
bun "$ROOT/probe-current-http2.ts" | tee "$ROOT/output-current-http2.jsonl"
bun "$ROOT/probe-local.ts" body | tee "$ROOT/output-body.jsonl"
bun "$ROOT/probe-local.ts" proxy | tee "$ROOT/output-proxy.jsonl"
bun "$ROOT/probe-local.ts" overhead | tee "$ROOT/output-overhead.jsonl"
bun "$ROOT/probe-abort-loop.ts" | tee "$ROOT/output-abort-loop.jsonl"
bun "$ROOT/probe-keepalive.ts" | tee "$ROOT/output-keepalive.jsonl"
bun "$ROOT/probe-multi.ts" | tee "$ROOT/output-multi.jsonl"
bun "$ROOT/probe-config-stream.ts" | tee "$ROOT/output-config-stream.jsonl"
node "$ROOT/probe-node-ping.mjs" | tee "$ROOT/output-node-ping.jsonl"
bun "$ROOT/probe-ttfb.ts" https://api.github.com/meta | tee "$ROOT/output-ttfb.jsonl"
