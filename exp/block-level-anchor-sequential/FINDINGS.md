# block-level-anchor-sequential — 顺序 anchor 的 CLI 安全性验证

归属:续写重试 spec（草案）的 Anthropic 承重前置门。补现有 `docs/spec/2026-07-11-block-level-buffered-retry.md` §4.5「备选形状」从未实现、从未验证的空白。

## 背景

现有块级缓冲重试在 **Anthropic 默认关**（`config.yaml` `protect_streaming_generation: false`），因为主形状 **anchor-coexist**（empty-text anchor@0 全程 open + 真实块@+1 在其之上同时 open）被实测判定 **CLI-unsafe**：真 Claude Code CLI 的 agent-loop 状态机比 `@anthropic-ai/sdk` 严，「两个 index 同时 open」把它搞糊涂 → 重新查询 → stall（`tests/e2e-client/anthropic-coexist-cli.e2e.test.ts` 的 `numTurns>1` 签名）。

spec §4.5 为此 FAIL 预留了「备选」：顺序 anchor（任一时刻只有一个块 open，anchor 在真实块打开前先 close，每个块间 gap 用一个新的 empty-text anchor 块 open+delta+close）。但 landing 时未实现、直接默认关。本 PoC 验证这个备选。

## 方法（mock upstream，真 CLI oracle）

- `hook.ts` — upstream hook（当前四点契约 `export const hooks = { exchange }`），发**顺序** wire：pre-content anchor@0（open+delta+close）→ 真实块@1 `"Hello "` → 块间 anchor@2（open+delta+close）→ 真实块@3 `"SEQUENTIAL_OK_MARKER"` → 终止。**不变量：任一时刻只有一个块 open。**
- `run.ts` / `run-raw.ts` — 复用 `tests/e2e-client/harness` 的 `spawnProxy`（非 4141，隔离 XDG/HOME，hook 全 mock 上游不烧 GHC）+ 真 `claude -p --output-format json`。

## 结果:PASS

- `numTurns === 1` — **不 stall**（agent-loop 未重查；对比 coexist 的 `>1`）。
- `stop_reason: end_turn`，`isError: false`。
- **两个真实块内容都保全**：原始输出含 `"Hello "`（大写 H，区别于小写 prompt `say hello`）+ `SEQUENTIAL_OK_MARKER`。块间穿插的空 anchor 块**未导致丢块**。

结论：**顺序 anchor 是 CLI-safe 的块级保活形状**，绕过了让现有 spec 卡在 Anthropic 默认关的 coexist stall。它同时（a）补上现有 spec 未完成的 Anthropic 块级默认 on，（b）让续写重试在 Anthropic+CLI（incident 场景）可行。附带优势：顺序形状不需要 coexist 逼出的 sink 块栈改造（更简单）。

## 剩余子门（未在本 PoC 覆盖）

- **300s 死线重置**:本 PoC 用短 wire（无长静默）。incident 的 142.9s 首字节前静默要求 anchor 的空 `text_delta` 每 ~15s 重置 CC 的 300s no-real-content 死线。这需要 >300s 的长静默真 CLI 跑（对比 `exp/cc-idle-280s`：裸 ping 不重置、真 text_delta 重置）。顺序 anchor 的 gap 保活也是 `text_delta`，预期重置，但**未实证**——列为计划期长-idle 子门。

## 复现

```bash
bun run exp/block-level-anchor-sequential/run.ts        # 断言 numTurns=1 + marker
bun run exp/block-level-anchor-sequential/run-raw.ts     # dump 原始 claude JSON 验两块保全
# 需要 claude on PATH + ~/.local/share/copilot-api/github_token
```
