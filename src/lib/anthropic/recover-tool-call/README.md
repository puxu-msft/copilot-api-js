# recover-tool-call

上游 tool-call 文本降级的透明恢复。详见 [docs/rfc/tool-call-text-recovery.md](../../../../docs/rfc/tool-call-text-recovery.md)。

## 结构
- `core.ts` — 纯函数：检测（findDowngradeMarkPos）、whitespace-tolerant 位置不变量解析（validateInvokeRegion / recoverDowngradeTail）、门控谓词（isResidueWhitespaceAdjacent / isInvokeTerminal）、schema 定型、合成 id（synthesizeToolUseId）。零依赖、零 I/O，可任意管线调用。
- `schema-extract.ts` — 纯函数：Tool[] → Map<name, ToolParamTypes>。
- `stream.ts` — SSE transform `createToolCallTextRecoverer(deps)`：processEvent/flush，CANDIDATE/COMMIT 两阶段。
- `response.ts` — 非流式 helper `recoverToolCallTextInResponse`。
- `index.ts` — barrel re-export。

## 问题
GitHub Copilot 的 Anthropic 上游偶发把工具调用渲染成命名空间被剥离的纯文本（`call<invoke name="X"><parameter name="K">V</parameter></invoke>`）塞进 text block，而不发标准 tool_use content block，`stop_reason` 仍是 tool_use（变体 A）或 end_turn（变体 B）。下游 Claude Code 期望 tool_use，收到 `<invoke>` 文本 → 解析失败、对话卡死。本模块在代理层检测并重建为标准 tool_use block。默认 off（`anthropic.tool_recover_call_text`）。

## 不变量
- **history 保真**：仅作用于转发给客户端的流（forwardedSseEvents）；raw sseEvents + accumulator 保留上游降级原貌。
- **绝不部分成功**：位置不变量校验把「content 含 </parameter> 字面量导致的腰斩」压成干净失败，绝不产出内容残缺的 tool_use。
- **失败回退零丢失**：门控不过 / 解析失败 / 流中断 → 原样透传缓冲帧。

## Transform 契约（v4 管线复用）
`createToolCallTextRecoverer(deps)` 是自包含 SSE transform：
- **依赖全部构造期注入**（`enabled` / `toolNames` / `toolSchemas`），不读任何全局 state。
- **输入**：上游 Anthropic SSE 事件流（`processEvent(parsed, raw) → frames[]`）。
- **输出**：客户端方向 SSE 事件流（0/1/多帧）。
- **位置假设**：运行在 `serverToolFilter` **之前**。发 wire-name tool_use、用上游 index 空间（maxSeen+1+k）；name 还原（wire→client）+ index densify 由下游 serverToolFilter 负责（单一职责）。
- **CANDIDATE/COMMIT 两阶段**：门控需 message_delta 的 stop_reason + P3（无 tool_use block），早于发帧不可知，故 text content_block_stop 时只持帧（CANDIDATE），message_delta 才发合成帧或回退（COMMIT）。每个 message_start 重置 message 级状态。

### v4 ResponseRewrite 对位（docs/v4/03-spec/rewrite-registry.md）
迁入 v4 P1 rewrite-registry 时，注册为一个 **S5 `ResponseRewrite`**：
- `name: "tool-call-text-recover"`
- `order: 150`（`thinking-sig-compat`100 < **本 150** < `tool-input-decode`200 < `server-tool-filter`300；必须 <300 以便下游 server-tool-filter 还原 name + densify index）
- `appliesTo(env): env.format === "anthropic" && state.recoverToolCallText`
- `transform(frame, state) → FrameAction`：当前 `processEvent` 的 `frames[]` 映射为 `{kind:"emit",frames}`；BUFFERING/CANDIDATE 持帧映射为 `{kind:"buffer"}`；`flush(state)` 同名。
- `RewriteState`：当前闭包内的 message 级（maxUpstreamIndexSeen/sawToolUseBlock/candidate）+ block 级状态搬到 v4 per-rewrite `RewriteState`。

core 与解析/门控逻辑在迁移中**零改动**——只换外层 transform 接口包装。
