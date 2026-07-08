#!/usr/bin/env bash
# Drive ONE oracle chain: real `claude` CLI → copilot-api proxy → mock GHC upstream.
#
# Prereqs (see README.md):
#   1. mock running (start-mock.sh) on $MOCK_PORT.
#   2. copilot-api proxy running on $PROXY_PORT with:
#        ghc_api_base_url: http://localhost:$MOCK_PORT
#        protect_streaming_generation: tool_use_only   (or: on)
#        stream_keepalive_mode: empty_text             (chain=keepalive contrast arm: content_delta)
#      and the operator's normal GitHub auth (the mock ignores the upstream token).
#
# Usage: run-chain.sh <keepalive|thinking|retry> [label]
#   Sets the mock chain via POST /__mode (resets attempt/turn counters), runs one headless
#   `claude -p`, records CC's --output-format json result + the mock's /__mode counters.
set -u
CHAIN="${1:?need chain: keepalive|thinking|retry}"
LABEL="${2:-$CHAIN}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOCK_PORT="${MOCK_PORT:-8890}"
PROXY_PORT="${PROXY_PORT:-4141}"
PROXY_TOKEN="${PROXY_TOKEN:-copilot-api}"
MODEL="${MOCK_MODEL:-claude-opus-4-8}"
# Wall-clock ceiling. keepalive chain must exceed the mock silence (default 320s) + tail; give margin.
CEIL="${CC_CEIL:-380}"

CCLOG="$DIR/$LABEL.cli.log"
SETTINGS="$DIR/settings.$LABEL.json"

# Prompt per chain: keepalive wants a plain answer; thinking/retry likewise (the mock, not the
# prompt, drives the block shapes). The tool round-trip in the thinking chain needs CC to actually
# run the returned Bash tool → pass --dangerously-skip-permissions (safe: the mock returns `echo`).
PROMPT="Reply with the single word: ok"
PERM_FLAG=""
if [ "$CHAIN" = "thinking" ]; then
  PROMPT="Investigate and report. Use any tool the assistant requests."
  PERM_FLAG="--dangerously-skip-permissions"
fi

# 1) select the chain on the mock (resets counters).
echo "[$LABEL] setting mock chain=$CHAIN …"
curl -s -X POST "http://localhost:$MOCK_PORT/__mode" -H 'content-type: application/json' -d "{\"chain\":\"$CHAIN\"}" || {
  echo "[$LABEL] ERROR: mock not reachable on :$MOCK_PORT — start start-mock.sh first" >&2 ; exit 2 ; }
echo

# 2) CC settings → PROXY (prod-faithful: custom base URL + token, exactly the incident wiring).
cat > "$SETTINGS" <<EOF
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:$PROXY_PORT",
    "ANTHROPIC_AUTH_TOKEN": "$PROXY_TOKEN",
    "ANTHROPIC_MODEL": "$MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL": "$MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "$MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "$MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "$MODEL",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "DISABLE_TELEMETRY": "1"
  }
}
EOF

echo "[$LABEL] START chain=$CHAIN proxy=:$PROXY_PORT mock=:$MOCK_PORT $(date -Is)"
START=$(date +%s.%N)
# shellcheck disable=SC2086
timeout "$CEIL" claude -p "$PROMPT" \
  --output-format json --settings "$SETTINGS" --strict-mcp-config $PERM_FLAG \
  > "$CCLOG" 2>&1
CCRC=$?
END=$(date +%s.%N)
WALL=$(echo "$END - $START" | bc)
echo "[$LABEL] DONE claude rc=$CCRC wall=${WALL}s (timeout ceiling=${CEIL}s)"

echo "[$LABEL] mock counters: $(curl -s "http://localhost:$MOCK_PORT/__mode")"
echo "[$LABEL] CC result (extract is_error/duration_ms/num_turns):"
grep -oE '"(is_error|duration_ms|num_turns|result|subtype)":[^,}]*' "$CCLOG" 2>/dev/null | sed "s/^/[$LABEL]   /" || true
echo "[$LABEL] full CC json → $CCLOG ; mock frame log → $DIR/mock.log"
