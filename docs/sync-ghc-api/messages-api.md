# Anthropic Messages API

## GHC 现状（9e668cb12 基线）

GHC 的 `src/platform/endpoint/node/messagesApi.ts` 是**强改写适配层**：主动构建 tool 列表、thinking 配置、context management、cache_control 等。

本轮相对 2603 基线的增量：

| 提交 | 内容 |
|------|------|
| #5010 (2026-04-06) | `thinkingConfig && endpoint.supportsReasoningEffort?.length` guard — 模型不声明 effort 支持则跳过 effort 字段（见 [thinking-system.md](thinking-system.md)）|
| #4966 (2026-04-03) | 移除 `forceExtendedThinking` 实验开关 |
| #4941 (2026-04-02) | Opus/Sonnet 4.6 使用新优化的 prompt 类作为默认（`Claude46OpusPrompt` / `Claude46SonnetPrompt`）|
| #4839 (2026-03-30) | 修复 orphan `CacheBreakpoint` 产生空白 text block，改为延迟附加或静默丢弃 |
| Summarization 修复链 | #4993 strip tool_search from summarization / #4992 count deferred tools in budget / #4988 omit `tool_choice` when no tools |

## 1. cache_control 自动注入 + tool 排序 — 已实现 ✅

### GHC 策略

- Anthropic 允许最多 **4 个** `cache_control` breakpoint（tools → system → messages 层级）
- `addToolsAndSystemCacheControl()` 在剩余 slot 内：最后一个非 deferred tool → 最后一个 system block
- 跳过 `defer_loading: true` 的 tool
- tool 排序：`tool_search_tool_regex` → non-deferred → deferred（稳定前缀 + 变动后缀，最大化缓存命中）
- **新增 #4839**：若 `CacheBreakpoint` 之前没有可附加的 content，延迟到下一个 cacheable block；如始终无则静默丢弃（修复 prompt-tsx 裁剪后遗留的孤立断点）

### 本项目现状

| 能力 | 位置 |
|------|------|
| `addToolsAndSystemCacheControl()` | `request-preparation.ts:163-240` 附近（`CACHE_CONTROL_BREAKPOINT_LIMIT = 4`）|
| tool 排序 `tool_search → nonDeferred → deferred` | `message-tools.ts:155-220` |
| 历史 tool name 收集（避免已用工具被 defer）| `message-tools.ts:153` |
| 递归统计 message 中已有的 breakpoint | `countExistingCacheBreakpoints` |

**#4839 兼容性**：本项目透传客户端发来的 `cache_control`，从不自己生成"空白 text block + cache_control"占位（该问题是 GHC `rawContentToAnthropicContent` 在 prompt-tsx 渲染后构造请求时产生的）。代理无此路径，天然不受影响。

## 2. Tool Search — 已实现 ✅

### GHC 策略

- Server-side：注入 `tool_search_tool_regex`（`type: tool_search_tool_regex_20251119`）
- Client-side custom：自定义 `tool_search`，结果转 `tool_reference` block
- 支持模型前缀：`claude-sonnet-4.5/4.6`、`claude-opus-4.5/4.6`
- Beta header: `advanced-tool-use-2025-11-20`

### 本项目现状

| 能力 | 位置 |
|------|------|
| Server-side 注入 | `message-tools.ts:157-163` |
| `defer_loading` 标记 | `message-tools.ts:166-187` |
| 模型覆盖 | `features.ts:74-82`（Sonnet/Opus 4.5/4.6）|
| Beta header | `features.ts:143-145` |
| `deferred-tool-retry` 策略（工具被拒后取消 defer 重试） | `src/lib/request/strategies/deferred-tool-retry.ts` |

## 3. Tool Result Content 过滤 — 已实现 ✅

GHC: tool_result 只保留 `text` / `image` / `document`。
本项目: `sanitize/tool-blocks.ts:163-168` 显式检查 `type !== "document"` 以保留 document。

## 4. Summarization 专属修复（#4993 / #4992 / #4988）— 不适用 🔲

这三个修复都针对 GHC 内部的 `summarizedConversationHistory.tsx`——当上游 context 溢出时，GHC 用一次额外的 LLM 调用对 conversation 做 summary，然后继续 agent loop。相关 bug：

- **#4993**：summarization 请求路径未经 agent allowlist 门控，导致 `tool_search` 注入被遗漏，Anthropic 拒绝 `tool_reference` 块。修复：在 summarization 前 strip `tool_search` tool_use/tool_result 对。
- **#4992**：GHC 在 3/30 的一次改动里把 deferred tools 从 `toolTokens` 计算中剔除，导致 budget 误判富裕 ~31K tokens，引发 context_length_exceeded → summarization 失败级联。修复：重新把 deferred tools 计入 tokens。
- **#4988**：空 tools 数组时 `normalizeToolSchema` 返回 undefined，但代码仍会发 `tool_choice: 'none'`，所有模型 API 都会 400。修复：无 tools 时不发 `tool_choice`。

**对代理影响**：本项目不做 conversation summarization（那是客户端职责），这些路径在我们这里**完全不存在**，因此均标为不适用。但 #4988 里的"empty tools 时不要发 `tool_choice`"是**一般性接口契约**，值得验证 OpenAI 路径 handler 是否同样遵守。

## 5. Trailing Assistant Message Guard

GHC 检测尾随 assistant 消息时追加 `{ role: 'user', content: 'Please continue.' }`。本项目作为代理透传客户端消息。`sanitize.ts` 管道处理 orphaned tool blocks，不负责尾随 assistant 修复——客户端（Claude Code 等）自行保证消息结构。P2，暂不实施。

## 6. Image / PDF / Thinking Round-trip — 已透传 ✅

- 客户端已按 Anthropic 格式构建图片和 PDF block，代理透传
- 客户端自己管理 thinking/redacted_thinking block 的回传
- 对于 `thinking_block_message_policy` 策略(默认 `preserve`),`thinking-protection.ts` 保证清洗不会修改/删除/重排已回传的 thinking 块(signature 自包含,块级保护即可)

## 本轮新增关注点

| # | 项目 | 优先级 | 说明 |
|---|------|--------|------|
| 1 | `tool_choice` 在 empty tools 下的处理 | P2 | 验证 Anthropic/OpenAI handler 是否会错发 |
| 2 | Orphan cache_control 透传健壮性 | P3 | 代理不产生孤立断点，但若客户端产生，可考虑校验后 drop |
