#!/usr/bin/env bash
# Single-arm driver: real `claude` 2.1.201 vs the idle-probe mock, first-party watchdog path.
# Usage: run-arm.sh <label> <TYPE> <PORT>
#   TYPE in {ping, thinkdelta, comment, textdelta}
# Records the exact +Ns at which CC aborts (from the mock log) + CC's own json result/error.
set -u
LABEL="${1:?need label}"
TYPE="${2:?need keepalive type}"
PORT="${3:?need port}"
INTERVAL="${INTERVAL:-20}"
WINDOW="${WINDOW:-340}"
CEIL="${CC_CEIL:-400}"

DIR="/home/xp/src/copilot-api-js/exp/cc-idle-280s"
MODE="idle:$TYPE:$INTERVAL:$WINDOW"
MOCKLOG="$DIR/$LABEL.mock.log"
CCLOG="$DIR/$LABEL.cli.log"
SETTINGS="$DIR/settings.$PORT.json"

MOCK_MODE="$MODE" MOCK_PORT="$PORT" bun run "$DIR/mock.ts" > "$MOCKLOG" 2>&1 &
MOCKPID=$!
sleep 1

# CC_FIRST_PARTY=1 (default): assume-first-party → CC's first-party body-idle watchdog path.
# CC_FIRST_PARTY=0: prod-faithful — custom base URL + token "copilot-api" (exactly how the real
#   settings.json points CC at the localhost:4141 proxy; the path the user's incident occurred on).
if [ "${CC_FIRST_PARTY:-1}" = "1" ]; then
  FP_LINE='    "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL": "1",'
  AUTH="dummy-mock-token"
else
  FP_LINE='    "_comment_prod_faithful": "custom URL, no first-party assume",'
  AUTH="copilot-api"
fi
cat > "$SETTINGS" <<EOF
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:$PORT",
    "ANTHROPIC_AUTH_TOKEN": "$AUTH",
    "ANTHROPIC_MODEL": "claude-opus-4-8",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-opus-4-8",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-opus-4-8",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-opus-4-8",
$FP_LINE
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "DISABLE_TELEMETRY": "1"
  }
}
EOF

echo "[$LABEL] START mock pid=$MOCKPID mode=$MODE port=$PORT $(date -Is)"
START=$(date +%s.%N)
timeout "$CEIL" claude -p "Reply with the single word: ok" \
  --output-format json --settings "$SETTINGS" --strict-mcp-config \
  > "$CCLOG" 2>&1
CCRC=$?
END=$(date +%s.%N)
WALL=$(echo "$END - $START" | bc)
echo "[$LABEL] DONE claude rc=$CCRC wall=${WALL}s"
kill $MOCKPID 2>/dev/null; wait $MOCKPID 2>/dev/null
