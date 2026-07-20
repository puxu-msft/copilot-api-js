#!/usr/bin/env bash
# Responses `response.ping` keepalive M-2 idle oracle — proxy-arm driver (Task 5 / plan-2-responses-http.md
# §Task 5 / spec §7.2 & §11 M-2, R4 default-flip gate).
#
# TOPOLOGY:  real `codex exec`  ──OpenAI Responses──▶  copilot-api PROXY (buffered ON)  ──ghc_api_base_url──▶  mock-upstream.ts (this repo, HTTPS/h2, silent-then-tail).
#
# THIS SCRIPT starts the mock upstream + drives ONE headless `codex exec` turn through the PROXY.
# It does NOT (and per project rule `no-auto-server` CANNOT) start the copilot-api proxy — the
# USER must already have it running, pointed at the mock with the arm's config (see the printed
# checklist + REPORT.md "运行指令"). Mirrors exp/cc-idle-280s/run-proxy-arm.sh's split.
#
# WHY the mock is HTTPS/h2 (not plain http, unlike the CC sibling's DIRECT-connect mock.ts): the
# PROXY's own upstream fetch (`transport/upstream-fetch.ts`) routes `https://` through node:http2
# and `http://` through undici — and undici's parser hangs / aborts prematurely under Bun on a
# silence-then-tail SSE stream (empirically confirmed while building this harness: the real proxy,
# pointed at an earlier plain-http version of this mock, ABORTED the upstream fetch ~5ms after
# headers instead of surviving the silence window). See REPORT.md §排障 + mock-upstream.ts header.
#
# Usage: run-proxy-arm.sh <label> [silence_sec]
#   label       : armPing | armSilent (or any label — used only for log file names)
#   silence_sec : upstream pre-first-item silence seconds (default 330; must be >300 and <
#                 proxy timeouts.response_header / timeouts.stream_idle, see oracle-config.yaml)
set -u
LABEL="${1:?need label (e.g. armPing or armSilent)}"
SILENCE="${2:-330}"

PROXY_URL="${PROXY_URL:-http://localhost:4141}"
MOCK_UPSTREAM_PORT="${MOCK_UPSTREAM_PORT:-8799}"
CEIL="${CODEX_CEIL:-420}" # wall-clock ceiling for the codex exec run (> silence + margin)
MODEL="${MOCK_MODEL_ID:-gpt-5.5}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOCKLOG="$DIR/$LABEL.mock-upstream.log"
CODEXLOG="$DIR/$LABEL.codex.jsonl"
ORACLELOG="$DIR/$LABEL.oracle.log"
CERT="$DIR/mock-cert.pem"
KEY="$DIR/mock-key.pem"

echo "======================================================================================"
echo "[$LABEL] Responses keepalive M-2 idle oracle   silence=${SILENCE}s   proxy=$PROXY_URL"
echo "  Topology:  codex exec  ->  copilot-api proxy ($PROXY_URL)  ->  mock-upstream (h2, :$MOCK_UPSTREAM_PORT)"
echo ""
echo "  PRE-FLIGHT CHECKLIST (the USER must have the proxy running BEFORE this script — no-auto-server):"
echo "   1. Proxy started with:  --ghc-api-base-url https://localhost:$MOCK_UPSTREAM_PORT"
echo "      and  NODE_EXTRA_CA_CERTS=$CERT  (trust the mock's self-signed cert; regenerated below if absent)"
echo "   2. config.yaml (openai_responses):  buffered_retry: true     # armPing: gate; armSilent: still true (only heartbeat differs)"
echo "                                       upstream_ws: false        # force HTTP transport (WS bypasses buffered heartbeat entirely)"
echo "   3. config.yaml (anthropic-shared):  stream_keepalive_ping_sec: 20   # armPing; set 0 for armSilent (see oracle-config.yaml §arm)"
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
#
# ORDERING NOTE (fixed 2026-07-14): the copilot-api PROXY hard-fails at boot if it cannot fetch
# `/models` from ghc_api_base_url (start.ts:468-474 → process.exit(1)). Since the proxy points at
# THIS mock's port, the mock must ALREADY be listening before the proxy starts — but this script is
# run AFTER the proxy. Chicken-and-egg. So the intended flow is: the USER starts ONE long-lived mock
# on $MOCK_UPSTREAM_PORT FIRST (it serves /models immediately, only /responses goes silent), THEN the
# proxy, THEN this script. Set MOCK_UPSTREAM_EXTERNAL=1 to REUSE that already-running mock instead of
# launching (and killing) our own — avoiding an 8799 port clash with the proxy's boot dependency.
if [ "${MOCK_UPSTREAM_EXTERNAL:-0}" = "1" ]; then
  MOCKPID=""
  echo "[$LABEL] REUSING external mock on :$MOCK_UPSTREAM_PORT (MOCK_UPSTREAM_EXTERNAL=1 — the user's long-lived mock; not launching/killing our own)"
else
  MOCK_UPSTREAM_MODE="silent:$SILENCE" MOCK_UPSTREAM_PORT="$MOCK_UPSTREAM_PORT" MOCK_MODEL_ID="$MODEL" \
    "$NODE_BIN" "$DIR/mock-upstream.ts" > "$MOCKLOG" 2>&1 &
  MOCKPID=$!
  sleep 1
fi

# Preflight: is the mock actually listening? (best-effort — a health probe over h2/TLS.)
if ! curl -sk --http2 -m 3 "https://localhost:$MOCK_UPSTREAM_PORT/models" -o /dev/null 2>/dev/null; then
  echo "[$LABEL] WARNING: mock at https://localhost:$MOCK_UPSTREAM_PORT not responding — check $MOCKLOG (or, with MOCK_UPSTREAM_EXTERNAL=1, that your long-lived mock is up)"
fi

# Preflight: is the proxy up? (best-effort — a health probe; don't hard-fail if the route 404s.)
if ! curl -sf -m 3 "$PROXY_URL/" -o /dev/null 2>/dev/null && ! curl -s -m 3 "$PROXY_URL/" -o /dev/null 2>/dev/null; then
  echo "[$LABEL] WARNING: proxy at $PROXY_URL not reachable — start it first (see checklist). Continuing anyway."
fi

echo "[$LABEL] START mock-upstream pid=$MOCKPID silence=${SILENCE}s ceil=${CEIL}s $(date -Is)"
START=$(date +%s.%N)
OPENAI_BASE_URL="$PROXY_URL/v1" OPENAI_API_KEY="dummy" \
  timeout "$CEIL" codex exec --json \
    -c model_provider=oracle \
    -c model_providers.oracle.name=oracle \
    -c model_providers.oracle.base_url="$PROXY_URL/v1" \
    -c model_providers.oracle.wire_api=responses \
    -c model_providers.oracle.preferred_auth_method=apikey \
    -c model="$MODEL" \
    -s read-only --skip-git-repo-check --ephemeral \
    "Reply with the single word: ok" \
    > "$CODEXLOG" 2>&1
CODEXRC=$?
END=$(date +%s.%N)
WALL=$(echo "$END - $START" | bc)
echo "[$LABEL] DONE codex exec rc=$CODEXRC wall=${WALL}s"

if [ -n "${MOCKPID:-}" ]; then kill "$MOCKPID" 2>/dev/null; wait "$MOCKPID" 2>/dev/null; fi

# Extract the oracle verdict from codex's --json event stream: `turn.completed` (success, carries
# usage) vs `turn.failed` (carries error.message). duration_ms is derived from our own wall-clock
# timer (codex's --json stream does not itself emit a duration_ms field — unlike Claude Code's
# --output-format json result, which has `is_error`/`duration_ms` directly; see REPORT.md §环境).
{
  echo "[$LABEL] wall_clock_s=$WALL codex_rc=$CODEXRC"
  if command -v jq >/dev/null 2>&1; then
    # codex --json interleaves plain-text lines (a "Reading additional input from stdin..."
    # banner + occasional rmcp ERROR lines from an unrelated local MCP server) with the actual
    # JSONL event stream — filter to lines that look like JSON objects before piping to jq, or
    # jq aborts on the first non-JSON line ("Invalid numeric literal").
    TURN_COMPLETED=$(grep '^{' "$CODEXLOG" | jq -c 'select(.type=="turn.completed")' 2>/dev/null | tail -1)
    TURN_FAILED=$(grep '^{' "$CODEXLOG" | jq -c 'select(.type=="turn.failed")' 2>/dev/null | tail -1)
    LAST_AGENT_MSG=$(grep '^{' "$CODEXLOG" | jq -r 'select(.type=="item.completed" and .item.type=="agent_message") | .item.text' 2>/dev/null | tail -1)
    if [ -n "$TURN_COMPLETED" ]; then
      echo "[$LABEL] is_error=false  turn.completed=$TURN_COMPLETED"
      echo "[$LABEL] last_agent_message=${LAST_AGENT_MSG:-<none>}"
    elif [ -n "$TURN_FAILED" ]; then
      echo "[$LABEL] is_error=true  turn.failed=$TURN_FAILED"
    else
      echo "[$LABEL] is_error=<unknown>  (neither turn.completed nor turn.failed found in $CODEXLOG — codex_rc=$CODEXRC, check for a timeout/crash)"
    fi
  else
    echo "[$LABEL] (install jq to auto-extract) tail of codex --json output:"
    tail -c 600 "$CODEXLOG"
  fi
  echo "[$LABEL] duration_ms (wall-clock proxy for codex's own turn duration) = $(echo "$WALL * 1000" | bc | cut -d. -f1)"
} | tee "$ORACLELOG"

echo "[$LABEL] logs: $CODEXLOG  +  $MOCKLOG  +  $ORACLELOG"
