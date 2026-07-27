# PoC：Anthropic 上游 assistant 消息内 thinking 布局的三条约束

结论文档见 [docs/spec/2026-07-26-thinking-terminal-block-layout.md](../../docs/spec/2026-07-26-thinking-terminal-block-layout.md)。本目录只留可复跑的探针。

## 为什么必须打真上游

最小构造复现不出来。用「两个真 thinking 块 + 一个 tool_use」拼的**最小**对话，`[T, tool, T]` 上游返回 **200**——若只跑这个探针会得出「C2 不存在」的错误结论。只有把**生产 400 的完整 payload** 原样重放（30 条消息、含 3 条内联 `role:"system"`、29 个 tool 定义）才复现出 C2 的 400。原因未查明（疑与内联 system 折叠/消息规模有关），**教训是：复现上游校验行为要用真实完整 payload，最小构造的阴性结果没有裁决力**。

## 复跑

```bash
# 1) 取一条真实的、含相邻 thinking 的失败请求（或任意带 thinking 的请求）
curl -s "localhost:4141/history/api/entries/<id>" -o /tmp/e-<id>.json   # 只读探针，别动 4141

# 2) 起隔离测试服务器（skill live-ghc-e2e-verification 的配方）
#    验「上游对某个排列怎么反应」时配 anthropic.thinking_destack_strategy: passthrough，
#    否则我方 L1 会把你精心构造的排列改写掉。
TESTDATA=/tmp/copilot-test-4142
mkdir -p "$TESTDATA/copilot-api"
cp ~/.local/share/copilot-api/{github_token,config.yaml} "$TESTDATA/copilot-api/"
printf '\nanthropic:\n  thinking_destack_strategy: passthrough\n  strip_thinking_on_reject: false\n' >> "$TESTDATA/copilot-api/config.yaml"
XDG_DATA_HOME=$TESTDATA NODE_ENV=production bun run ./packages/cli/src/main.ts start --port 4142 > $TESTDATA/server.log 2>&1 &

# 3) 逐变体重放（改脚本顶部的 SRC 指向你的 entry）
python3 replay-400.py 4142 replay-asis
python3 replay-400.py 4142 sep-mid-tool-end append-sep-at-end thinking-only-sep-end tool-interleaved-mid

# 4) 修复后的端到端复验：默认 move_blocks 的服务器 + 客户端原始 payload
python3 verify-fix-e2e.py 4143
```

## 坑

- **重放 upstream body 会撞 "Tool names must be unique"**：我方会注入 `Grep`/`Glob`/`Task`/`KillShell`/`tool_search_tool_regex` 等 tool 定义，把已注入过的 body 再喂回去就重复了。脚本里已按名字剔除这批再发（`injected` 集合）。这是重放伪影，不是缺陷。
- **每次重放烧约 90k input token**（真实计费），靶向发、别做仪式性全量。
