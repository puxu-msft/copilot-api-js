#!/usr/bin/env bash
# LIVE-path pre-response keepalive oracle driver (task 7.1 / spec §10.8 / ADR 2026-07-09).
#
# TOPOLOGY:  real `claude` (CC)  ─→  copilot-api PROXY :4141  ─→  mock-upstream.ts (this repo).
#   This differs from run-arm.sh (CC ← mock DIRECTLY). Here CC drives the PROXY, and the mock sits
#   UPSTREAM of the proxy so the PROXY's empty_text synthesis is what's under test.
#
# THIS SCRIPT starts the mock upstream + drives headless CC. It does NOT (and per project rule
# `no-auto-server` CANNOT) start the copilot-api proxy — the USER must have it running on :4141,
# pointed at the mock with the per-arm config (see the printed checklist + REPORT.md "运行指令").
#
# Usage: run-proxy-arm.sh <label> <keepalive_mode> [silence_sec]
#   keepalive_mode : empty_text | ping | enveloped_ping  (INFORMATIONAL — the proxy's ACTUAL mode is
#                    whatever the running proxy is configured with; set it BEFORE running this arm.)
#   silence_sec    : upstream pre-response silence seconds (default 330; must be >300 and < proxy
#                    timeouts.response_header / timeouts.stream_idle).
set -u
LABEL="${1:?need label (e.g. armLive-empty_text)}"
MODE="${2:?need keepalive_mode: empty_text|ping|enveloped_ping}"
SILENCE="${3:-330}"

PROXY_URL="${PROXY_URL:-http://localhost:4141}"
PROXY_TOKEN="${PROXY_TOKEN:-copilot-api}" # the auth token the real settings.json uses to reach the 4141 proxy
MOCK_UPSTREAM_PORT="${MOCK_UPSTREAM_PORT:-8799}"
CEIL="${CC_CEIL:-420}" # wall-clock ceiling for the CC run (> silence + margin)

DIR="/home/xp/src/copilot-api-js/exp/cc-idle-280s"
MOCKLOG="$DIR/$LABEL.mock-upstream.log"
CCLOG="$DIR/$LABEL.cli.log"
SETTINGS="$DIR/settings.proxy.$LABEL.json"

echo "======================================================================================"
echo "[$LABEL] LIVE pre-response keepalive oracle   keepalive_mode=$MODE  silence=${SILENCE}s"
echo "  Topology:  claude (CC)  ->  copilot-api proxy ($PROXY_URL)  ->  mock-upstream (:$MOCK_UPSTREAM_PORT)"
echo ""
echo "  PRE-FLIGHT CHECKLIST (the USER must have the proxy running BEFORE this script — no-auto-server):"
echo "   1. Proxy started with:  --ghc-api-base-url http://localhost:$MOCK_UPSTREAM_PORT"
echo "   2. config.yaml (anthropic):  protect_streaming_generation: false   # LIVE / delayed-commit path"
echo "                                stream_commit_after_sec: 20"
echo "                                stream_keepalive_ping_sec: 20"
echo "                                stream_keepalive_mode: $MODE           # <-- SET PER ARM (hot-reloadable)"
echo "   3. config.yaml (timeouts):   response_header: 900   stream_idle: 900   # MUST exceed silence=${SILENCE}s"
echo "   4. Proxy reachable at $PROXY_URL"
echo "======================================================================================"

# Start the mock upstream (a test double, not the project server — safe to launch here).
MOCK_UPSTREAM_MODE="silent:$SILENCE:text" MOCK_UPSTREAM_PORT="$MOCK_UPSTREAM_PORT" \
  bun run "$DIR/mock-upstream.ts" > "$MOCKLOG" 2>&1 &
MOCKPID=$!
sleep 1

# Preflight: is the proxy up? (best-effort — a health probe; don't hard-fail if the route 404s.)
if ! curl -sf -m 3 "$PROXY_URL/" -o /dev/null 2>/dev/null && ! curl -s -m 3 "$PROXY_URL/" -o /dev/null 2>/dev/null; then
  echo "[$LABEL] WARNING: proxy at $PROXY_URL not reachable — start it first (see checklist). Continuing anyway."
fi

cat > "$SETTINGS" <<EOF
{
  "env": {
    "ANTHROPIC_BASE_URL": "$PROXY_URL",
    "ANTHROPIC_AUTH_TOKEN": "$PROXY_TOKEN",
    "ANTHROPIC_MODEL": "claude-opus-4-8",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-opus-4-8",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-opus-4-8",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-opus-4-8",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "DISABLE_TELEMETRY": "1"
  }
}
EOF

echo "[$LABEL] START mock-upstream pid=$MOCKPID silence=${SILENCE}s ceil=${CEIL}s $(date -Is)"
START=$(date +%s.%N)
timeout "$CEIL" claude -p "Reply with the single word: ok" \
  --output-format json --settings "$SETTINGS" --strict-mcp-config \
  > "$CCLOG" 2>&1
CCRC=$?
END=$(date +%s.%N)
WALL=$(echo "$END - $START" | bc)
echo "[$LABEL] DONE claude rc=$CCRC wall=${WALL}s"

# Extract CC's own verdict (is_error / duration_ms) from the --output-format json result.
if command -v jq >/dev/null 2>&1; then
  echo "[$LABEL] CC result:  is_error=$(jq -r '.is_error // "?"' "$CCLOG" 2>/dev/null)  duration_ms=$(jq -r '.duration_ms // "?"' "$CCLOG" 2>/dev/null)  subtype=$(jq -r '.subtype // "?"' "$CCLOG" 2>/dev/null)"
else
  echo "[$LABEL] (install jq to auto-extract) tail of CC result:"; tail -c 400 "$CCLOG"
fi

kill "$MOCKPID" 2>/dev/null; wait "$MOCKPID" 2>/dev/null
echo "[$LABEL] logs: $CCLOG  +  $MOCKLOG"
