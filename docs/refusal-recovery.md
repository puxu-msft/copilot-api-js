# Refusal SSE 处理（thinking-only refusal 三模式）

把上游 Anthropic 的 **thinking-only refusal** 响应（`stop_reason:"refusal"`，仅有一个 thinking 块、无 `text`/`tool_use`）按配置 `anthropic.refusal_sse_rewrite` 三选一处理，避免客户端拿到空/坏轮。

## 问题（实测）

`req_1782214935133_68`：opus-4.8、432k input、112 tools、adaptive thinking 的正经编码轮，上游思考 1058 token 后**拒绝**（`stop_reason:"refusal"`，仅 thinking 块、无可用内容）。代理此前**逐字节透传**、打 `[OK]`；客户端（Claude Code）拿到空/坏轮——session 时间线证实 refusal 之后每轮 user 都变「继续」，用户被迫手动推进卡住的轮次。

## 三模式（`anthropic.refusal_sse_rewrite`，默认 `error`）

| 值 | 行为 | 终态 |
|---|---|---|
| `refusal` | 透传上游原始 refusal，不改写（客户端拿到 dead/空轮） | complete（成功，与历史透传一致） |
| `end_turn` | **追加**合成 `text` 块（`REFUSAL_RECOVERY_TEXT`：说明被拒、建议换表述/拆步/换模型）+ `stop_reason:"refusal"→"end_turn"`（清 `stop_details`） | complete（成功） |
| `error` | 发 Anthropic `event: error` SSE 帧（替换上游终止帧）+ **`ctx.fail` 记请求失败** | failed（`[FAIL]`） |

**默认 `error`**：refusal 是上游语义失败，应显式失败（对齐截断检测「上游语义失败必记 `ctx.fail`、不谎报成功」不变量），而非伪装成 end_turn 成功轮。`error` 帧对客户端：Anthropic SDK 读到流内 `event: error` 会 `throw APIError`、不自动重试（流已 commit）——与真实 Anthropic 流内错误等价（见 memory `reference-claude-code-timeout-and-sse-error-oracle`）。

**门控（三模式共用）**：仅当 `stop_reason==="refusal"` **且**整条响应无 client-visible `text`/`tool_use` 块时触发（thinking-only/空，**排除 `server_tool_use`**）。带真内容或非 refusal 一律透传。判定 `isThinkingOnlyRefusal`（`recover-refusal.ts`）。

## 为何 error 模式落在 rewrite 层（而非 handler drain 后）

refusal 是**带 `message_stop` 的 clean drain**。若先透传原始 `message_delta{refusal}`+`message_stop` 再在 handler drain 后追加 error 帧，客户端会收到「一个完成的 turn 紧跟一个 error」的畸形帧序。截断检测之所以能在 handler drain 后 `writeSynthetic`，恰因截断**无** `message_stop`、error 帧是流唯一终止符。故 `error` 模式的发帧+抑制原终止帧落在 S5 rewrite 层（`createRefusalErrorEmitter`：suppress 原 delta + emit error 帧 + suppress 随后 message_stop），handler 只负责 `ctx.fail` 终态。

## 可观测性归属（单点不重复）

- `end_turn`：rewrite 层 `onRecover` 记 `recordFeature("refusal-recovered")` + info 日志（handler 正常 complete，唯一知道做了 recovery 的是 rewrite 层）。
- `error`：handler complete 分支**一处全包** `ctx.fail` + `recordFeature("refusal-errored")` + error 日志（emitter 纯改流无副作用）。两层独立判定同一上游原始条件（同口径排除 server_tool_use），故 handler 必触发、无遗漏；refusal-error 分支**优先于截断分支**，避免 refusal+无 message_stop 复合场景双 error 帧。

## 为何保留 thinking 块（而非剥离）

该 thinking 块带**有效签名**，Anthropic thinking 签名**自包含**（加密的是 thinking 内容本身、与上下文/位置无关），原样回放可被上游接受——**不是**「双空块」（text 与 signature 都空）那种触发 400 的毒块，故无需剥离。且流式剥离需缓冲整个 thinking 阶段（活 UX 回归），所以只追加/替换、不剥离。

## History 保真

只改**转发/渲染**响应。driver 在 S5 改写链**之前**采样上游原始帧并喂 accumulator，故 history 的 `sseEvents` 与记录的 `stop_reason` 保留真实上游 `refusal`（含 `stop_details`）：客户端看到 end_turn/error，history 看到原始 refusal。

## compat 迁移

旧布尔 `anthropic.refusal_recover_text` → 新枚举 `anthropic.refusal_sse_rewrite`：`true→"end_turn"`（旧合成行为）、`false→"refusal"`（旧透传）。见 `compat.ts`。

## 已知缺口

web_search 双跳旁路走 legacy direct、**不经 driver/S5**，故 `refusal_sse_rewrite` 三模式对 web_search 路径无效（与既有 web_search bypass 暂缓清单一致）。`count_tokens` 不产生成响应、结构上无 refusal，非问题。

## 实现

- 纯逻辑：[recover-refusal.ts](../src/lib/anthropic/recover-refusal.ts) —— `isThinkingOnlyRefusal` 门控 + `createRefusalRecoverer`（end_turn 流式合成）/`recoverRefusalInResponse`（end_turn 非流式）/`createRefusalErrorEmitter`（error 流式发帧，纯改流无副作用）。
- 接入：第 5 条 Anthropic `ResponseRewrite`（`order 400`）的 `refusalRewrite`（[response-rewrite-adapters.ts](../src/lib/codec/anthropic/response-rewrite-adapters.ts)）按 `state.refusalSseRewrite` 三分叉；handler error 分支（流式 complete + 非流式 `renderNonStreamingV4` 返 500）在 [handler-v4.ts](../src/routes/messages/handler-v4.ts)。
- 合成帧契约：error 帧带 `event: error` 行（否则 Anthropic SDK 静默丢弃 eventless data 帧，见 memory `reference-anthropic-sdk-drops-eventless-sse-frames`）。

## 测试

- 单元：[recover-refusal.unit.test.ts](../tests/anthropic/recover-refusal.unit.test.ts)（`createRefusalRecoverer` + `createRefusalErrorEmitter` 状态机 + 门控真值表 + 非流式）。
- golden（字节锁）：[response-rewrite-golden.http.test.ts](../tests/anthropic/response-rewrite-golden.http.test.ts) S8（流式 end_turn）+ S8 refusal mode（透传）+ S6 refusal（非流式 end_turn）。
- 热重载：[config-hot-reload.it.test.ts](../tests/config/config-hot-reload.it.test.ts) 的 `anthropic.refusal_sse_rewrite` 条目。
