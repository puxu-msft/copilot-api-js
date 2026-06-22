#!/usr/bin/env bash
# Part (a) driver: run the REAL `claude` CLI against the mock and record when it gives up.
#
# Usage: cc-run.sh <label> <MOCK_MODE> [extra-env...]
# Spawns a fresh mock with MOCK_MODE, then runs `claude -p` pointed at it via ANTHROPIC_BASE_URL.
# The mock logs (with monotonic timestamps) when CC's request arrives and when CC aborts it — that
# delta is the disconnect time. CC's own stderr/exit is captured too.
#
# probe-harness-must-match-prod: we set _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL so CC applies the
# SAME body-idle watchdog / timeout path it uses against the real first-party Anthropic endpoint.
set -u
LABEL="${1:?need label}"
MODE="${2:?need MOCK_MODE}"
shift 2

DIR="/home/xp/src/copilot-api-js/exp/q2-oracle"
PORT="${MOCK_PORT:-8788}"
MOCKLOG="$DIR/cc.$LABEL.mock.log"
CCLOG="$DIR/cc.$LABEL.cli.log"

# fresh mock
MOCK_MODE="$MODE" MOCK_PORT="$PORT" bun run "$DIR/mock-server.ts" > "$MOCKLOG" 2>&1 &
MOCKPID=$!
sleep 1

# per-port settings override: --settings is command-line precedence (above user settings.json env
# block, which otherwise pins ANTHROPIC_BASE_URL=localhost:4141). _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL
# makes CC apply the production body-idle watchdog to our mock (probe-harness-must-match-prod).
SETTINGS="$DIR/cc-settings.$PORT.json"
# CC_FIRST_PARTY=1 (default): assume-first-party => CC's first-party timeout path.
# CC_FIRST_PARTY=0: prod-faithful — custom base URL + auth token "copilot-api" (exactly how the real
#   settings.json points CC at the localhost:4141 proxy; this is the path the incident occurred on).
if [ "${CC_FIRST_PARTY:-1}" = "1" ]; then
  FP_LINE='    "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL": "1",'
  AUTH="dummy-mock-token"
else
  FP_LINE='    "_comment_no_first_party": "prod-faithful custom URL",'
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

echo "[$LABEL] mock pid=$MOCKPID mode=$MODE port=$PORT  $(date -Is)"
START=$(date +%s.%N)

# Drive CC headless. timeout is a hard ceiling so a never-disconnecting CC can't hang us forever.
CEIL="${CC_CEIL:-700}"
env \
  "$@" \
  timeout "$CEIL" claude -p "Reply with the single word: ok" \
    --output-format json --settings "$SETTINGS" --strict-mcp-config \
  > "$CCLOG" 2>&1
CCRC=$?

END=$(date +%s.%N)
WALL=$(echo "$END - $START" | bc)
echo "[$LABEL] claude exited rc=$CCRC wall=${WALL}s"
echo "[$LABEL] --- mock log ---"; cat "$MOCKLOG"
echo "[$LABEL] --- cli log (head) ---"; head -c 1500 "$CCLOG"; echo
kill $MOCKPID 2>/dev/null
wait $MOCKPID 2>/dev/null
echo "[$LABEL] done"
