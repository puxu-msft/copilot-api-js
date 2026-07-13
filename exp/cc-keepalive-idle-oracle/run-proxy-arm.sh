#!/usr/bin/env bash
# Chat Completions keepalive M-2 idle oracle — proxy-arm driver (P3 Task 3 / plan-3-chat-completions.md
# Task 3 / spec §7.1 & §11 M-2, R4 default-flip gate).
#
# TOPOLOGY:  real openai-node client (oracle-client.mjs)  ──/v1/chat/completions──▶  copilot-api PROXY
#            (chat_completions.buffered_retry ON)  ──ghc_api_base_url──▶  mock-upstream.ts (this repo,
#            HTTPS/h2, silent-then-tail).
#
# THIS SCRIPT starts the mock upstream + drives ONE streaming CC request through the PROXY. It does
# NOT (and per project rule `no-auto-server` CANNOT) start the copilot-api proxy — the USER must
# already have it running, pointed at the mock with the arm's config (see the printed checklist +
# REPORT.md "运行指令"). Mirrors exp/responses-keepalive-idle-oracle/run-proxy-arm.sh's split.
#
# WHY the mock is HTTPS/h2 (reused from the sibling, not re-discovered here): the PROXY's own
# upstream fetch (`transport/upstream-fetch.ts`) routes `https://` through node:http2 and `http://`
# through undici — and undici's parser hangs/aborts prematurely under Bun on a silence-then-tail SSE
# stream (empirically confirmed by the sibling Responses harness). See mock-upstream.ts header +
# REPORT.md §排障.
#
# Usage: run-proxy-arm.sh <label> [silence_sec] [ceil_sec]
#   label       : armPing | armSilent (or any label — used only for log file names)
#   silence_sec : upstream pure silence seconds after the first chunk (default 330; must be >300
#                 and < proxy timeouts.response_header / timeouts.stream_idle, see oracle-config.yaml)
#   ceil_sec    : oracle client's own wall-clock ceiling (default 420; must be > silence_sec + margin)
set -u
LABEL="${1:?need label (e.g. armPing or armSilent)}"
SILENCE="${2:-330}"
CEIL="${3:-${CODEX_CEIL:-420}}"

PROXY_URL="${PROXY_URL:-http://localhost:4141}"
MOCK_UPSTREAM_PORT="${MOCK_UPSTREAM_PORT:-8798}"
MODEL="${MOCK_MODEL_ID:-gpt-5.4}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOCKLOG="$DIR/$LABEL.mock-upstream.log"
CLIENTLOG="$DIR/$LABEL.oracle-client.log"
ORACLELOG="$DIR/$LABEL.oracle.log"
CERT="$DIR/mock-cert.pem"
KEY="$DIR/mock-key.pem"

echo "======================================================================================"
echo "[$LABEL] Chat Completions keepalive M-2 idle oracle   silence=${SILENCE}s   proxy=$PROXY_URL"
echo "  Topology:  oracle-client.mjs (openai-node)  ->  copilot-api proxy ($PROXY_URL)  ->  mock-upstream (h2, :$MOCK_UPSTREAM_PORT)"
echo ""
echo "  PRE-FLIGHT CHECKLIST (the USER must have the proxy running BEFORE this script — no-auto-server):"
echo "   1. Proxy started with:  --ghc-api-base-url https://localhost:$MOCK_UPSTREAM_PORT"
echo "      and  NODE_EXTRA_CA_CERTS=$CERT  (trust the mock's self-signed cert; regenerated below if absent)"
echo "   2. config.yaml (chat_completions):  buffered_retry: true    # armPing: gate; armSilent: still true (only heartbeat differs)"
echo "   3. config.yaml (buffered_retry / anthropic):            heartbeat_sec: 15  # armPing; anthropic.stream_keepalive_ping_sec: 0 for armSilent (see oracle-config.yaml §arm)"
echo "   4. config.yaml (timeouts):          response_header: 900   stream_idle: 900   # MUST exceed silence=${SILENCE}s"
echo "   5. Proxy reachable at $PROXY_URL"
echo "======================================================================================"

# Generate the mock's self-signed localhost cert if absent (idempotent).
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "[$LABEL] generating self-signed localhost cert -> $CERT / $KEY"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$KEY" -out "$CERT" \
    -days 3650 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1 \
    || { echo "[$LABEL] ERROR: openssl cert generation failed" >&2; exit 3; }
fi

# Pick a Node that supports running .ts directly (type-stripping, Node 22.6+/24).
NODE_BIN="${NODE_BIN:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "[$LABEL] ERROR: node not found (need Node 22.6+/24 to run mock-upstream.ts via type-stripping)" >&2
  exit 4
fi

# Start the mock upstream (a test double, not the project server — safe to launch here).
MOCK_UPSTREAM_MODE="silent:$SILENCE" MOCK_UPSTREAM_PORT="$MOCK_UPSTREAM_PORT" MOCK_MODEL_ID="$MODEL" \
  "$NODE_BIN" "$DIR/mock-upstream.ts" > "$MOCKLOG" 2>&1 &
MOCKPID=$!
sleep 1

# Preflight: is the mock actually listening? (best-effort — a health probe over h2/TLS.)
if ! curl -sk --http2 -m 3 "https://localhost:$MOCK_UPSTREAM_PORT/models" -o /dev/null 2>/dev/null; then
  echo "[$LABEL] WARNING: mock at https://localhost:$MOCK_UPSTREAM_PORT not responding — check $MOCKLOG"
fi

# Preflight: is the proxy up? (best-effort — a health probe; don't hard-fail if the route 404s.)
if ! curl -sf -m 3 "$PROXY_URL/" -o /dev/null 2>/dev/null && ! curl -s -m 3 "$PROXY_URL/" -o /dev/null 2>/dev/null; then
  echo "[$LABEL] WARNING: proxy at $PROXY_URL not reachable — start it first (see checklist). Continuing anyway."
fi

echo "[$LABEL] START mock-upstream pid=$MOCKPID silence=${SILENCE}s ceil=${CEIL}s $(date -Is)"
START=$(date +%s.%N)
MOCK_MODEL_ID="$MODEL" \
  timeout "$((CEIL + 15))" "$NODE_BIN" "$DIR/oracle-client.mjs" "$LABEL" "$PROXY_URL" "$SILENCE" "$CEIL" \
  > "$CLIENTLOG" 2>&1
CLIENTRC=$?
END=$(date +%s.%N)
WALL=$(echo "$END - $START" | bc)
echo "[$LABEL] DONE oracle-client rc=$CLIENTRC wall=${WALL}s"

kill "$MOCKPID" 2>/dev/null; wait "$MOCKPID" 2>/dev/null

# Extract the oracle verdict from oracle-client.mjs's single trailing JSON line (stdout, captured
# in CLIENTLOG — it interleaves per-chunk stderr diagnostics with ONE final stdout JSON line, so grep
# for the line that parses as JSON with an `is_error` key).
{
  echo "[$LABEL] wall_clock_s=$WALL client_rc=$CLIENTRC"
  if command -v jq >/dev/null 2>&1; then
    VERDICT=$(grep '^{' "$CLIENTLOG" | jq -c 'select(has("is_error"))' 2>/dev/null | tail -1)
    if [ -n "$VERDICT" ]; then
      echo "[$LABEL] verdict=$VERDICT"
    else
      echo "[$LABEL] verdict=<unknown>  (no JSON verdict line found in $CLIENTLOG — client_rc=$CLIENTRC, check for a timeout/crash; rc=124 means the ceiling fired)"
    fi
  else
    echo "[$LABEL] (install jq to auto-extract) tail of oracle-client.mjs output:"
    tail -c 600 "$CLIENTLOG"
  fi
} | tee "$ORACLELOG"

echo "[$LABEL] logs: $CLIENTLOG  +  $MOCKLOG  +  $ORACLELOG"
