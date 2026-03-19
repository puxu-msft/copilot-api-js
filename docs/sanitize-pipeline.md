# 消息清洗管道

## 概述

消息清洗分为两个阶段（`src/lib/anthropic/sanitize.ts`），确保发送到 Anthropic API 的消息符合协议要求。

## Phase 1: 预处理（`preprocessAnthropicMessages`）

一次性幂等操作，在请求进入 routing/retry pipeline 前执行一次。auto-truncate 重试后**不需要**重新执行，因为截断不会引入新的重复或新的 system-reminder 标签。

1. **stripReadToolResultTags** — [可选] 剥离 Read 工具结果中所有注入的 `<system-reminder>` 标签（由 `state.stripReadToolResultTags` 控制，默认关闭）
2. **deduplicateToolCalls** — [可选] 去重重复的 tool_use/tool_result 对，保留最后出现的（由 `state.dedupToolCalls` 控制：`false` 禁用，`"input"` 按工具名+输入匹配，`"result"` 还需结果相同）

## Phase 2: 可重复清洗（`sanitizeAnthropicMessages`）

每次 auto-truncate 重试后**必须重新执行**，因为截断可能打破 tool_use/tool_result 配对并产生空块。

1. **sanitizeAnthropicSystemPrompt** — 清理 system prompt 中的 `<system-reminder>` 标签
2. **removeAnthropicSystemReminders** — 重写/移除消息中的 `<system-reminder>` 标签（由 `state.rewriteSystemReminders` 控制：`true` 全部移除，`false` 全部保留，规则数组按顺序匹配重写）
3. **processToolBlocks** — 修复 tool_use name 大小写 + 过滤孤儿 tool_use/tool_result 块
4. **filterEmptyAnthropicTextBlocks** — 安全网：移除任何来源产生的空 text 块

## Tool Blocks 处理

`processToolBlocks()` 的职责：

1. **保留所有配对完整的 tool_use/tool_result**，不管工具是否在当前 `tools` 数组中
2. **只过滤孤立的块**：没有 `tool_result` 的 `tool_use`，没有 `tool_use` 的 `tool_result`
3. **修正工具名大小写**：如果工具在 `tools` 数组中但大小写不同，修正为正确的大小写

相关代码：`src/lib/anthropic/sanitize.ts`
