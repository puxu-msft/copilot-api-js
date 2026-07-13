#!/usr/bin/env bash
# 驱动真实 Claude Code 客户端打 fake Anthropic server，观测其对各错误帧序列的重试行为。
# 用法：./run-probe.sh <VARIANT> [PORT]
# oracle：① fake server 命中次数（>1 = CC 重发整轮）② stream-json 里的 api_retry 事件
# 绝不碰 4141 主服务器；只起/杀自己按 PID。
set -u
VARIANT="${1:?need variant}"
PORT="${2:-4199}"
DIR="$(cd "$(dirname "$0")" && pwd)"
TMPCFG="$(mktemp -d /tmp/cc-probe-cfg.XXXXXX)"
OUT="$(mktemp /tmp/cc-probe-out.XXXXXX)"
FAKELOG="$(mktemp /tmp/cc-probe-fake.XXXXXX)"

cleanup() {
  [ -n "${FAKE_PID:-}" ] && kill "$FAKE_PID" 2>/dev/null
  rm -rf "$TMPCFG"
}
trap cleanup EXIT

# 起 fake server
VARIANT="$VARIANT" PORT="$PORT" bun "$DIR/fake-anthropic-server.ts" >"$FAKELOG" 2>&1 &
FAKE_PID=$!
sleep 0.8

if ! kill -0 "$FAKE_PID" 2>/dev/null; then
  echo "FAKE SERVER FAILED TO START:"; cat "$FAKELOG"; exit 1
fi

# 驱动 claude -p，隔离 config dir，强制 API-key 模式（→ Bo()=false，匹配代理场景）
timeout 90 env \
  CLAUDE_CONFIG_DIR="$TMPCFG" \
  ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" \
  ANTHROPIC_API_KEY="sk-fake-probe-key" \
  ANTHROPIC_MODEL="claude-sonnet-4-5-20250929" \
  DISABLE_TELEMETRY=1 \
  DISABLE_AUTOUPDATER=1 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  claude -p "say hi" --output-format stream-json --verbose --max-turns 1 \
  >"$OUT" 2>&1
CC_EXIT=$?

sleep 0.3
HITS=$(curl -s "http://127.0.0.1:$PORT/hits" 2>/dev/null)

echo "=================== VARIANT=$VARIANT PORT=$PORT ==================="
echo "--- CC exit code: $CC_EXIT ---"
echo "--- fake server /hits: $HITS ---"
echo "--- fake server log (每行一次 upstream 命中) ---"
cat "$FAKELOG"
echo "--- CC stream-json 里 system/error/api_retry 相关行 ---"
grep -oE '"(type|subtype)":"[^"]*"' "$OUT" | sort | uniq -c | head -30
echo "--- api_retry 事件明细（若有）---"
grep -o '"subtype":"api_retry"[^}]*}' "$OUT" | head
echo "--- CC 输出末尾（含最终 result / 错误呈现）---"
tail -c 1200 "$OUT"
echo ""
echo "=================== END $VARIANT ==================="
