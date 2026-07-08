#!/usr/bin/env bash
# POSITIVE CONTROL for the thinking chain (chain 2) — strictly isolates the PROXY's
# `filterEmptyAnthropicTextBlocks` as the thing that strips the leading empty-text anchor.
#
# WHY this exists: a clean end-to-end `run-chain.sh thinking` run proves only that the anchor did
# NOT reach upstream un-stripped (production-safe) — it CANNOT attribute the stripping to the proxy
# vs. Claude Code, because CC may itself drop a leading empty text block when it rebuilds turn-2.
# This probe removes CC from the loop: it hand-crafts a turn-2 body carrying
# [empty text, thinking, tool_use] and sends it STRAIGHT to the proxy. If the proxy strips the
# empty text, thinking becomes the first block again and the mock (which validates thinking-first
# on every MAIN-model inbound, exactly like real Anthropic) does NOT 400. So:
#     mock validationRejections == 0  →  the PROXY stripped it  (gate PASS)
#     mock validationRejections >= 1  →  the proxy did NOT strip it (gate NG — would 400 in prod)
#
# The mock's `validationRejections` counter is the authoritative oracle here (not the proxy's
# response shape), because it reflects what actually reached upstream.
#
# Prereqs (see README.md): mock running (start-mock.sh) + proxy running with
#   ghc_api_base_url: http://localhost:$MOCK_PORT, protect_streaming_generation: tool_use_only.
#
# Usage: replay-turn2.sh [label]
set -u
LABEL="${1:-replay-turn2}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOCK_PORT="${MOCK_PORT:-8890}"
PROXY_PORT="${PROXY_PORT:-4141}"
PROXY_TOKEN="${PROXY_TOKEN:-copilot-api}"
MODEL="${MOCK_MODEL:-claude-opus-4-8}"

BODYFILE="$DIR/$LABEL.request.json"
RESPFILE="$DIR/$LABEL.response.log"

# 1) select the thinking chain (resets counters). validationRejections starts at 0.
echo "[$LABEL] setting mock chain=thinking (resets counters) …"
curl -s -X POST "http://localhost:$MOCK_PORT/__mode" -H 'content-type: application/json' -d '{"chain":"thinking"}' || {
  echo "[$LABEL] ERROR: mock not reachable on :$MOCK_PORT — start start-mock.sh first" >&2 ; exit 2 ; }
echo

# 2) craft the turn-2 body: a leading EMPTY text block (the anchor CC would echo back), then a
#    valid thinking block, then the tool_use, then the tool_result. If the proxy fails to strip
#    the empty text, thinking is NOT first → the mock 400s (real-Anthropic invariant).
cat > "$BODYFILE" <<EOF
{
  "model": "$MODEL",
  "max_tokens": 2048,
  "stream": true,
  "thinking": { "type": "enabled", "budget_tokens": 1024 },
  "tools": [
    { "name": "Bash", "description": "run a shell command",
      "input_schema": { "type": "object", "properties": { "command": { "type": "string" } }, "required": ["command"] } }
  ],
  "messages": [
    { "role": "user", "content": "Investigate and report." },
    { "role": "assistant", "content": [
      { "type": "text", "text": "" },
      { "type": "thinking", "thinking": "Let me think about this briefly.", "signature": "bW9ja3NpZ25hdHVyZQ==" },
      { "type": "tool_use", "id": "toolu_mock_oracle_01", "name": "Bash", "input": { "command": "echo oracle-tool-ran" } }
    ] },
    { "role": "user", "content": [
      { "type": "tool_result", "tool_use_id": "toolu_mock_oracle_01", "content": "oracle-tool-ran" }
    ] }
  ]
}
EOF

# 3) POST straight to the PROXY (no CC). Send the same auth headers CC would (harmless if the proxy
#    doesn't enforce them). Capture the HTTP status + streamed body for the record.
echo "[$LABEL] POST turn-2 body → proxy :$PROXY_PORT (bypassing CC) $(date -Is)"
HTTP_STATUS=$(curl -s -N -o "$RESPFILE" -w '%{http_code}' \
  -X POST "http://localhost:$PROXY_PORT/v1/messages" \
  -H 'content-type: application/json' \
  -H "x-api-key: $PROXY_TOKEN" \
  -H "authorization: Bearer $PROXY_TOKEN" \
  -H 'anthropic-version: 2023-06-01' \
  --data-binary @"$BODYFILE")
echo "[$LABEL] proxy HTTP status: $HTTP_STATUS (response body → $RESPFILE)"

# 4) the AUTHORITATIVE oracle: the mock's counters after the replay.
COUNTERS=$(curl -s "http://localhost:$MOCK_PORT/__mode")
echo "[$LABEL] mock counters: $COUNTERS"

REJ=$(printf '%s' "$COUNTERS" | grep -oE '"validationRejections":[0-9]+' | grep -oE '[0-9]+$')
SEEN=$(printf '%s' "$COUNTERS" | grep -oE '"messagesSeen":[0-9]+' | grep -oE '[0-9]+$')
REJ="${REJ:-?}"; SEEN="${SEEN:-?}"

echo "[$LABEL] ── VERDICT ──────────────────────────────────────────────"
if [ "$SEEN" = "0" ]; then
  echo "[$LABEL] INCONCLUSIVE: the replay never reached the mock (messagesSeen=0). Check proxy wiring."
elif [ "$REJ" = "0" ]; then
  echo "[$LABEL] PASS: proxy STRIPPED the leading empty-text anchor (validationRejections=0, messagesSeen=$SEEN)."
  echo "[$LABEL]       This isolates filterEmptyAnthropicTextBlocks as the stripper (CC not in the loop)."
else
  echo "[$LABEL] NG:   proxy did NOT strip the empty-text anchor (validationRejections=$REJ) → would 400 in prod."
fi
