#!/usr/bin/env bash
# 2 轮 runner：驱动 CC 走 turn1（fake 返回带签名 thinking+text）→ turn2（fake 400-signature），
# 观察 CC 是否在 turn2 剥 thinking 块并重发（旗舰自愈委派端到端证据）。
# oracle：fake 命中次数（turn1=1 + turn2 若自愈重发则 ≥2）+ 每 hit 的 reqHasThinking。
set -u
PORT="${1:-5500}"
DIR="$(cd "$(dirname "$0")" && pwd)"
TMPCFG="$(mktemp -d /tmp/cc-sig-cfg.XXXXXX)"
OUT="$(mktemp /tmp/cc-sig-out.XXXXXX)"
FAKELOG="$(mktemp /tmp/cc-sig-fake.XXXXXX)"
cleanup() { [ -n "${FAKE_PID:-}" ] && kill "$FAKE_PID" 2>/dev/null; rm -rf "$TMPCFG"; }
trap cleanup EXIT

VARIANT="sig-conv" PORT="$PORT" bun "$DIR/fake-anthropic-server.ts" >"$FAKELOG" 2>&1 &
FAKE_PID=$!
sleep 0.8
kill -0 "$FAKE_PID" 2>/dev/null || { echo "FAKE FAILED:"; cat "$FAKELOG"; exit 1; }

# 两条 user 消息经 stream-json 喂入（realtime streaming input），CC 处理成两轮同一会话
{
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"First question, please think."}}'
  sleep 6
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Second question, follow up."}}'
  sleep 6
} | timeout 90 env \
  CLAUDE_CONFIG_DIR="$TMPCFG" \
  ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" \
  ANTHROPIC_API_KEY="sk-fake-probe-key" \
  ANTHROPIC_MODEL="claude-sonnet-4-5-20250929" \
  DISABLE_TELEMETRY=1 DISABLE_AUTOUPDATER=1 \
  claude -p --input-format stream-json --output-format stream-json --verbose \
  >"$OUT" 2>&1
CC_EXIT=$?

sleep 0.3
HITS=$(curl -s "http://127.0.0.1:$PORT/hits" 2>/dev/null)
echo "=================== sig-conv PORT=$PORT ==================="
echo "--- CC exit: $CC_EXIT | /hits: $HITS ---"
echo "--- fake log（关注 hit#2 reqHasThinking + 是否有 hit#3 = 剥块后重发）---"
cat "$FAKELOG"
echo "--- CC stream-json 事件计数 ---"
grep -oE '"(type|subtype)":"[^"]*"' "$OUT" | sort | uniq -c
echo "--- CC 输出末尾 ---"
tail -c 900 "$OUT"
