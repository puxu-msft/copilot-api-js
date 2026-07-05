# 把 `refusal_recover_text` 改造为三值枚举 `refusal_sse_rewrite`

## Context

当前 `anthropic.refusal_recover_text`（布尔，state `recoverRefusalText`）只有两态：开=把上游 thinking-only refusal（`stop_reason:"refusal"` 仅有 thinking 块、无 text/tool_use）合成成一个 `end_turn` 文本轮；关=透传原始 refusal。用户要新增第三种处理——把 refusal 以**普通 error SSE** 呈现给客户端，并在代理内部**记请求失败**（对齐截断检测的"上游语义失败必须 `ctx.fail`、不可谎报 complete"不变量）。

改造为字符串枚举 `anthropic.refusal_sse_rewrite`，三值：

| 值 | 行为 | ≈旧值 | 终态 |
|---|---|---|---|
| `refusal` | 透传上游原始 refusal，不改写（客户端拿到 dead turn） | `false` | complete（成功，与今日透传一致） |
| `end_turn` | 现行为：合成 text 块 + 改 `stop_reason`→`end_turn` | `true` | complete（成功） |
| `error` | **新增**：发 Anthropic `event: error` 帧 + `ctx.fail` | — | **failed**（[FAIL]） |

**默认值 = `error`**（用户拍板）。实际生效默认今日是 `end_turn`（bundled `config.yaml:521` = `true`，bundled 优先于硬编码兜底）；改后没显式配过的用户从"合成成功文本"变为"记失败 + error 帧"——符合项目立场（refusal 是上游语义失败，应显式失败而非伪装成功轮）。compat 迁移保证**显式配过**的老用户平滑（`true→end_turn`、`false→refusal`，行为不变）。

`error` 帧对客户端的可观测效果：Anthropic SDK（`@anthropic-ai/sdk` `core/streaming.js:111-115`）读到流内 `event: error` 帧会 `throw APIError`、**不自动重试**（流已 commit）——与真实 Anthropic 流内错误等价（见 memory `reference-claude-code-timeout-and-sse-error-oracle`）。

## 关键架构约束（已对抗核验）

1. **error 帧必须由 rewrite 层在流中替换原始终止帧，不能在 handler drain 后追加。** refusal 是**带 `message_stop` 的 clean drain**；若先透传原始 `message_delta{refusal}`+`message_stop` 再追加 error 帧，客户端会收到"一个完成的 turn 紧跟一个 error"的畸形帧序（高层 `MessageStream` 已 resolve `finalMessage`，error 到来时流已 settle）。截断检测之所以能在 handler drain 后 `writeSynthetic`，恰因截断**无** `message_stop`、error 帧是流唯一终止符。所以 `error` 模式的发帧+抑制原始终止帧**落在 S5 rewrite 层**，handler 只负责 `ctx.fail` 终态。

2. **判定口径必须排除 `server_tool_use`。** rewrite 层 recoverer 的 `sawRealContent` 看的是 post-filter 帧流（server-tool-filter order 300 已 suppress server_tool_use）；handler 的 `acc` 看上游原始帧（**含** server_tool_use）。两处都必须只把 client-visible `text`/`tool_use` 算 real content。`acc.contentBlocks` 的 type 已区分（`tool_use` vs `server_tool_use`，见 [stream-accumulator.ts:50-61](src/lib/anthropic/stream-accumulator.ts#L50)），故 handler 判定写 `acc.contentBlocks.some(b => b.type === "text" || b.type === "tool_use")` 即与 rewrite 口径一致——**不需要新信号通道**。

3. **`error` 模式 handler 分支必须优先于截断分支**（避免 refusal+无message_stop 复合场景下双 error 帧）。

4. **非流式 error 用 `c.json(errorBody, 5xx)` 返回，绝不 `throw`**——保持 `setInboundResponseHeaders` 时序（throw 会跳过 `c.json` → 漏 inboundResponse 腿）。检测读 **upstream-original** `response.stop_reason`，不读 `runResponseWhole` 后的 finalResponse。

## 改动分组

### A. 配置三件套（机械改名 + bool→enum）

照搬同 section 既有字符串枚举范式（`thinking_signature_compat` / `thinking_block_message_policy`）：

- [src/lib/config/schema.ts:297](src/lib/config/schema.ts#L297)：`refusal_recover_text: nullableBoolean()` → `refusal_sse_rewrite: nullableEnum(["refusal", "end_turn", "error"] as const)`（`nullableEnum` helper 在 schema.ts:75）。
- [config.yaml:517-521](config.yaml#L517)：key 改名 + 值 `error` + 重写注释（描述三值）。
- [src/lib/config/config.ts:574](src/lib/config/config.ts#L574)：`if (a.refusal_sse_rewrite !== undefined) setAnthropicBehavior({ refusalSseRewrite: a.refusal_sse_rewrite })`（retain-on-absence，与相邻 enum 字段同构）。
- [src/lib/state.ts](src/lib/state.ts)：类型 `:147`（`boolean` → `"refusal" | "end_turn" | "error"`，更新 JSDoc）；`setAnthropicBehavior` 的 `Pick` union `:874`；CONFIG_MANAGED_DEFAULTS `:1081`（`false` → `"error" as ...`，**与 bundled 对齐**消除历史分歧）；`resetConfigManagedState` `:1161`；`mutableState` init `:1230`——全部 key 重命名。
- [src/lib/config/compat.ts](src/lib/config/compat.ts)：在 `CONFIG_MIGRATIONS` 数组新增 `renameLeaf`，照抄 `auto_cache_control` bool→enum 范本（compat.ts:172-178）：
  ```ts
  renameLeaf("anthropic.refusal_recover_text", "anthropic.refusal_sse_rewrite", {
    transform: (v) => (typeof v === "boolean" ? (v ? "end_turn" : "refusal") : undefined),
    message: 'anthropic.refusal_recover_text is removed; use refusal_sse_rewrite ("refusal" | "end_turn" | "error")',
  }),
  ```

### B. 核心逻辑（[src/lib/anthropic/recover-refusal.ts](src/lib/anthropic/recover-refusal.ts)）

- **保留不动**：`createRefusalRecoverer`（end_turn 流式合成）+ `recoverRefusalInResponse`（end_turn 非流式）+ 纯助手 `isThinkingOnlyRefusal`/`buildSyntheticTextFrames`/`rewriteRefusalMessageDelta`——end_turn 模式算法核**零改动**（复用算法核、只加分叉）。
- **新增** `createRefusalErrorEmitter(deps)`（与 `createRefusalRecoverer` 同构状态机，共享 `maxIndex`/`sawRealContent`/`isThinkingOnlyRefusal`）：在 thinking-only refusal 的 `message_delta` 处 **suppress 原始 delta + emit 一个 Anthropic `event: error` 帧**（替代终止符）+ 置 `suppressTrailing=true`；随后的 `message_stop` 帧在 `suppressTrailing` 下 **suppress**。`onRecover` 回调记 feature。error 帧用 [post-commit-error.ts:93](src/routes/messages/post-commit-error.ts#L93) 的现成 `anthropicErrorFrame("api_error", message)` 构造器（避免重复手搓 `{event:"error", data:...}`）。
- error 帧 message：一句简洁说明（refusal 被上游策略拦截、建议换表述/拆步/换模型），可复用 `REFUSAL_RECOVERY_TEXT` 的措辞精神。

### C. rewrite adapter 三模式分叉（[response-rewrite-adapters.ts:258-282](src/lib/codec/anthropic/response-rewrite-adapters.ts#L258)）

`refusalRewrite`：
- `appliesTo`: `ANTHROPIC(env) && state.refusalSseRewrite !== "refusal"`（refusal 模式 → driver 整条跳过 = 透传）。
- `createState`: 按 `state.refusalSseRewrite` 分叉——`end_turn`→`createRefusalRecoverer`；`error`→`createRefusalErrorEmitter`。state 持有正确变体。
- `transform`: 走 state 变体的 `processEvent`（两变体同签名）。
- `transformWhole`: `end_turn`→`recoverRefusalInResponse`；`error`/`refusal`→identity（error 非流式由 handler 处理；transformWhole 必须 passthrough，否则 end_turn 核会改 stop_reason 使 handler 检测失效）。

### D. handler 流式（[handler-v4.ts:960-984](src/routes/messages/handler-v4.ts#L960) complete 分支）

在 `acc.streamError`（H2）之后、`!acc.sawMessageStop`（截断）**之前**插入新分支（约束 3 的优先级）：
```ts
} else if (state.refusalSseRewrite === "error"
           && isThinkingOnlyRefusal(acc.stopReason, acc.contentBlocks.some(b => b.type === "text" || b.type === "tool_use"))) {
  // error 帧已由 rewrite 层 emit（进 forwarded 轨）；handler 只记失败终态，不写帧。
  const partial = buildAnthropicResponseData(acc, model)
  consola.error(`[REFUSAL] upstream thinking-only refusal for ${acc.model || model} → recorded as error`)
  env.ctx.fail(acc.model || model, new Error("upstream thinking-only refusal"), { usage: partial.usage, stop_reason: partial.stop_reason, content: partial.content })
}
```
（不调 `writeSynthetic`——error 帧来自 rewrite emit、已进 `inboundResponse`；保留 partial thinking → richest-data-flow。）

### E. handler 非流式（[renderNonStreamingV4 handler-v4.ts:692-716](src/routes/messages/handler-v4.ts#L692)）

在语义截断门（`anthropicNonStreamingTruncation`）旁新增 refusal-error 判定：当 `state.refusalSseRewrite === "error"` 且 upstream-original `response.stop_reason === "refusal"` 且无 text/tool_use 块 → 构造 Anthropic error body `{type:"error", error:{type:"api_error", message}}`，`c.json(errorBody, 500)`（**非 200，使客户端 SDK throw**）+ `setInboundResponseHeaders` + `ctx.fail`，**不 throw**（约束 4）。error 模式下 `transformWhole` 已 passthrough（C 节），故 finalResponse 仍是上游原始 refusal——但客户端收到的是 error body 而非该 response。

## 测试

- **单元** [tests/anthropic/recover-refusal.unit.test.ts](tests/anthropic/recover-refusal.unit.test.ts)：加 `createRefusalErrorEmitter` 用例——message_delta 处 emit error 帧 + suppress、随后 message_stop suppress、复合边界（refusal 后无 message_stop 不产双帧由 handler 互斥保证，此处测 emitter 不重复 emit）、非 refusal 透传。
- **golden** [tests/anthropic/response-rewrite-golden.http.test.ts](tests/anthropic/response-rewrite-golden.http.test.ts) S8（流式）/S6（非流式）：扩成三模式（`refusal`/`end_turn`/`error`），`setStateForTests` 改用 `refusalSseRewrite`。error 场景断言：`inboundResponse.sseEvents` 含 error 帧（rewrite emit 进 forwarded 轨）+ `outboundResponse`/history `sseEvents` 保上游原始 refusal（含 stop_details）+ entry 终态 = **failed**。
- **热重载** [tests/config/config-hot-reload.it.test.ts:551-557](tests/config/config-hot-reload.it.test.ts#L551)：改成 enum 条目（sample 用非默认值如 `"refusal"`），完整性守卫自动覆盖；可加默认值 sanity 断言。

## 文档与已知缺口

- [docs/DESIGN.md](docs/DESIGN.md)：运行时选项表 `recoverRefusalText` 行（:303）改为 `refusalSseRewrite` 三值 + 活的架构现状表 refusal 行（:65,70）；[docs/refusal-recovery.md](docs/refusal-recovery.md) 重写为三模式；[.claude/skills/anthropic-debug/SKILL.md:17](.claude/skills/anthropic-debug/SKILL.md#L17) 更新。
- **已知缺口（文档化，不在本次实现）**：web_search 双跳旁路走 legacy direct（[handler-v4.ts:198-215](src/routes/messages/handler-v4.ts#L198)）**不经 driver/S5**，故 `refusal_sse_rewrite` 三模式对 web_search 路径无效。在 DESIGN.md/refusal-recovery.md 显式标注此缺口（与既有"web_search bypass 暂缓"清单一致）。`count_tokens` 不产生成响应、结构上无 refusal，非问题。

## 验证

改的是 `.ts` + `.yaml`（影响编译/运行），需跑验证：

```bash
bun run typecheck
bun run test:backend        # 全 offline 套件
bun run lint:all            # eslint --fix（不直接 prettier）
```

重点关注：`tests/config/`（热重载完整性守卫 + compat 迁移）、`tests/anthropic/recover-refusal.unit` + `response-rewrite-golden.http`（三模式行为 + history 保真 + error 终态）。golden 关注 `error` 模式的 outbound/inbound 非对称（上游原始 refusal vs 客户端实收 error 帧）+ entry 记 failed。

服务器行为（实发 error 帧给真实 Claude Code）按项目纪律 `no-auto-server` 由用户手动启动验证。
