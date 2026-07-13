#!/usr/bin/env bash
# 驱动真 CC 打 raw-TCP RST fake server，测真 TCP RST 在不同块完成状态下是否触发 CC 重发。
# 用法：./run-rst.sh <RSTVARIANT> <RST_MODE(terminate|end)> [PORT]
set -u
RSTVARIANT="${1:?variant}"; RST_MODE="${2:-terminate}"; PORT="${3:-4199}"
DIR="$(cd "$(dirname "$0")" && pwd)"
TMPCFG="$(mktemp -d /tmp/cc-rst-cfg.XXXXXX)"; OUT="$(mktemp /tmp/cc-rst-out.XXXXXX)"; LOG="$(mktemp /tmp/cc-rst-log.XXXXXX)"
cleanup() { [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null; rm -rf "$TMPCFG"; }
trap cleanup EXIT
RSTVARIANT="$RSTVARIANT" RST_MODE="$RST_MODE" PORT="$PORT" bun "$DIR/rst-fake-server.ts" >"$LOG" 2>&1 &
PID=$!; sleep 0.8
kill -0 "$PID" 2>/dev/null || { echo "FAIL START:"; cat "$LOG"; exit 1; }
timeout 60 env CLAUDE_CONFIG_DIR="$TMPCFG" ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" ANTHROPIC_API_KEY="sk-fake" ANTHROPIC_MODEL="claude-sonnet-4-5-20250929" DISABLE_TELEMETRY=1 DISABLE_AUTOUPDATER=1 \
  claude -p "hi" --output-format stream-json --verbose --max-turns 1 >"$OUT" 2>&1
conns=$(grep -c "CONN #" "$LOG")
echo "$RSTVARIANT [$RST_MODE]: upstream_conns=$conns | $(grep -oE '"error":"[a-z_]*"|API Error[^"]*' "$OUT" | tail -1)"
