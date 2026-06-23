# Refusal Recovery（thinking-only refusal 拦截）

把上游 Anthropic 的 **thinking-only refusal** 响应（`stop_reason:"refusal"`，仅有一个 thinking 块、无 `text`/`tool_use`）转成可用的文本完成，避免客户端拿到空/坏轮。

## 问题（实测）

`req_1782214935133_68`：opus-4.8、432k input、112 tools、adaptive thinking 的正经编码轮，上游回了：

```
message_start（content:[]）
content_block_start{type:"thinking", thinking:"", signature:""}
content_block_delta{signature_delta:S}          ← S 是有效非空签名
content_block_stop
message_delta{stop_reason:"refusal", stop_details:{type:"refusal", explanation:...}}
message_stop
```

即模型思考了 1058 token 后**拒绝**，没产出任何可用内容。代理此前**逐字节透传**、打 `[OK]`。客户端（Claude Code）拿到一个空/坏轮——session 时间线证实：refusal 之后每一轮 user 都变成「继续」，用户被迫手动推进卡住的轮次。Anthropic 端 `refusal` 此前完全无处理（`refusal` 仅在 OpenAI 翻译路径出现）。

## 行为

开启 `anthropic.refusal_recover_text`（默认 `false`）后，检测到 thinking-only refusal 时：

1. **追加**一个合成 `text` 块（`REFUSAL_RECOVERY_TEXT`，说明本轮被上游拒绝、建议换表述/拆步/换模型）。
2. 把 `stop_reason:"refusal" → "end_turn"`，并清掉 `stop_details`。
3. **不剥** thinking 块。

门控：仅当 `stop_reason==="refusal"` **且**整条响应无 `text`/`tool_use` 块时触发（thinking-only / 空内容）。refusal 但已有真内容、或非 refusal 一律原样透传。

### 为何保留 thinking 块（而非剥离）

该 thinking 块带**有效签名**，而 Anthropic thinking 签名是**自包含**的（加密的是 thinking 内容本身、与上下文/位置无关），原样回放可被上游接受。它**不是**「双空块」（text 与 signature 都空）那种会触发 400 的毒块——故无需剥离。且流式路径上剥离需缓冲整个 thinking 阶段（活 UX 回归），所以**只追加、不剥离**。

### 为何在 message_delta 边界追加（流式）

refusal 只在 `message_delta` 才可知，那时 thinking 帧已转发、无法回收。在该边界注入合成 text 块 + 改写 delta **无需缓冲**，对常见（非 refusal）路径零延迟。非流式整条 JSON 在手，直接等价改写。

## 实现

- 纯逻辑：[src/lib/anthropic/recover-refusal.ts](../src/lib/anthropic/recover-refusal.ts) —— `createRefusalRecoverer`（流式逐帧状态机）+ `recoverRefusalInResponse`（非流式整体）+ 纯助手（`isThinkingOnlyRefusal`/`buildSyntheticTextFrames`/`rewriteRefusalMessageDelta`）。
- 接入：作为第 5 条 Anthropic `ResponseRewrite`（`order: 400`，跑在最后）加入 [response-rewrite-adapters.ts](../src/lib/codec/anthropic/response-rewrite-adapters.ts) 的 `ANTHROPIC_RESPONSE_REWRITES`，由 driver S5 链（流式 `transform` / 非流式 `transformWhole`）驱动。`appliesTo` 关时 driver 整条跳过 = 逐字节透传。
- 激活记 `ctx.recordFeature("refusal-recovered")` + 一行 `[REFUSAL]` info 日志。

## History 保真

只改**转发/渲染**响应。driver 在 S5 改写链**之前**采样上游原始帧并喂 accumulator，故 history 的 `sseEvents` 与记录的 `stop_reason` 保留真实上游 `refusal`（含 `stop_details`）不变——客户端看到 `end_turn` + 合成文本，history 看到原始 refusal。

## 测试

- 单元：[tests/anthropic/recover-refusal.unit.test.ts](../tests/anthropic/recover-refusal.unit.test.ts)（纯助手 + 状态机：门控真值表 / 索引计算 / 多 thinking 块 / 无内容块 / 非 refusal 透传 / 不可变性）。
- 集成 golden（字节锁）：[tests/anthropic/response-rewrite-golden.http.test.ts](../tests/anthropic/response-rewrite-golden.http.test.ts) 的 S8（流式）+ S6 refusal（非流式），含「关时逐字节透传」+「history 保留上游 refusal」断言。
- 热重载：[tests/config/config-hot-reload.it.test.ts](../tests/config/config-hot-reload.it.test.ts) 的 `anthropic.refusal_recover_text` 条目（完整性守卫）。
