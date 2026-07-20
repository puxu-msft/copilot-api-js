#!/usr/bin/env bash
# Responses buffered-merge Codex real-consumer oracle — proxy-arm driver
# (spec 2026-07-14-responses-buffered-block-merge §8.2 / plan Task 5.6 — NON-BLOCKING, manual).
#
# TOPOLOGY:  real `codex exec`  ──OpenAI Responses──▶  copilot-api PROXY  ──ghc_api_base_url──▶  mock-upstream.ts (HTTPS/h2).
#
# THIS SCRIPT starts the mock upstream for ONE arm + drives ONE headless `codex exec` turn through the
# PROXY. It does NOT (and per project rule `no-auto-server` CANNOT) start the copilot-api proxy — the
# USER must already have it running, pointed at the mock (see the printed checklist).
#
# NON-BLOCKING: this oracle does NOT gate the feature's defaults (buffered_retry stays default OFF; the
# two merge knobs ride on it). It only gives a one-hand data point on whether a REAL Codex consumer
# reconstructs the drop-delta MERGED wire identically to the VERBATIM wire — evidence for a FUTURE
# "default-on" decision, not a prerequisite for landing this feature.
#
# Usage: run-proxy-arm.sh <arm>
#   arm : verbatim | merged   (selects the mock's frame shape; run BOTH and diff the codex outputs)
set -u
ARM="${1:?need arm (verbatim | merged)}"
case "$ARM" in verbatim|merged) ;; *) echo "ERROR: arm must be 'verbatim' or 'merged'" >&2; exit 2 ;; esac

PROXY_URL="${PROXY_URL:-http://localhost:4141}"
MOCK_UPSTREAM_PORT="${MOCK_UPSTREAM_PORT:-8788}"
CEIL="${CODEX_CEIL:-120}"
MODEL="${MOCK_MODEL_ID:-gpt-5.5}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOCKLOG="$DIR/$ARM.mock-upstream.log"
CODEXLOG="$DIR/$ARM.codex.jsonl"
ORACLELOG="$DIR/$ARM.oracle.log"
CERT="$DIR/mock-cert.pem"
KEY="$DIR/mock-key.pem"

echo "======================================================================================"
echo "[$ARM] Responses buffered-merge Codex oracle   proxy=$PROXY_URL   mock=:$MOCK_UPSTREAM_PORT"
echo "USER CHECKLIST — the PROXY must already be running with:"
echo "   1. ghc_api_base_url: https://localhost:$MOCK_UPSTREAM_PORT   (points the proxy at THIS mock)"
echo "   2. openai_responses.buffered_retry: true                    (engage the buffered path)"
echo "   3. openai_responses.buffered_merge.event_compaction: drop-delta (or item-summary to compare)"
echo "   4. Proxy reachable at $PROXY_URL, model '$MODEL' routable to /responses"
echo "NOTE: the mock arm is chosen by THIS script (verbatim vs merged), so the proxy can stay on ONE"
echo "      config across both runs — only the upstream wire changes. Run both arms + diff the codex outputs."
echo "======================================================================================"

# Generate the mock's self-signed localhost cert if absent (idempotent).
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "[$ARM] generating self-signed localhost cert -> $CERT / $KEY"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$KEY" -out "$CERT" \
    -days 3650 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1 \
    || { echo "[$ARM] ERROR: openssl cert generation failed" >&2; exit 3; }
fi

# Start the mock upstream for this arm (a test double — safe to launch here; NOT the project server).
# Set MOCK_UPSTREAM_EXTERNAL=1 to reuse an already-running mock (the proxy hard-fails at boot if it
# cannot fetch /models, so the mock must be up before the proxy — see the sibling keepalive oracle).
if [ "${MOCK_UPSTREAM_EXTERNAL:-0}" = "1" ]; then
  MOCKPID=""
  echo "[$ARM] REUSING external mock on :$MOCK_UPSTREAM_PORT — restart it with MOCK_ARM=$ARM to switch arm"
else
  MOCK_ARM="$ARM" MOCK_UPSTREAM_PORT="$MOCK_UPSTREAM_PORT" MOCK_MODEL_ID="$MODEL" \
    bun run "$DIR/mock-upstream.ts" > "$MOCKLOG" 2>&1 &
  MOCKPID=$!
  sleep 1
fi

if ! curl -sk --http2 -m 3 "https://localhost:$MOCK_UPSTREAM_PORT/models" -o /dev/null 2>/dev/null; then
  echo "[$ARM] WARNING: mock at https://localhost:$MOCK_UPSTREAM_PORT not responding — check $MOCKLOG"
fi
if ! curl -s -m 3 "$PROXY_URL/" -o /dev/null 2>/dev/null; then
  echo "[$ARM] WARNING: proxy at $PROXY_URL not reachable — start it first (see checklist). Continuing anyway."
fi

echo "[$ARM] START mock pid=$MOCKPID $(date -Is)"
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
    "Repeat back verbatim the single sentence the assistant message contains." \
    > "$CODEXLOG" 2>&1
CODEXRC=$?
END=$(date +%s.%N)
WALL=$(echo "$END - $START" | bc)
echo "[$ARM] DONE codex exec rc=$CODEXRC wall=${WALL}s"

if [ -n "${MOCKPID:-}" ]; then kill "$MOCKPID" 2>/dev/null; wait "$MOCKPID" 2>/dev/null; fi

{
  echo "[$ARM] wall_clock_s=$WALL codex_rc=$CODEXRC"
  if command -v jq >/dev/null 2>&1; then
    TURN_COMPLETED=$(grep '^{' "$CODEXLOG" | jq -c 'select(.type=="turn.completed")' 2>/dev/null | tail -1)
    TURN_FAILED=$(grep '^{' "$CODEXLOG" | jq -c 'select(.type=="turn.failed")' 2>/dev/null | tail -1)
    LAST_AGENT_MSG=$(grep '^{' "$CODEXLOG" | jq -r 'select(.type=="item.completed" and .item.type=="agent_message") | .item.text' 2>/dev/null | tail -1)
    if [ -n "$TURN_COMPLETED" ]; then
      echo "[$ARM] is_error=false  last_agent_message=${LAST_AGENT_MSG:-<none>}"
    elif [ -n "$TURN_FAILED" ]; then
      echo "[$ARM] is_error=true  turn.failed=$TURN_FAILED"
    else
      echo "[$ARM] is_error=<unknown>  (check $CODEXLOG — codex_rc=$CODEXRC)"
    fi
  else
    echo "[$ARM] (install jq to auto-extract) tail of codex --json output:"
    tail -c 600 "$CODEXLOG"
  fi
} | tee "$ORACLELOG"
