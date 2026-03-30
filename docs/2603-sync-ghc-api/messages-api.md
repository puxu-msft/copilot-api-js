# Anthropic Messages API

## GHC 的 Messages API 实现 (`messagesApi.ts`)

GHC 的 Messages API 实现是最复杂的端点之一，包含多个本项目尚未实现的特性。

## 1. cache_control 自动注入 — P0

### GHC 行为

GHC 在 `addToolsAndSystemCacheControl()` 中自动为 tools 和 system 添加 `cache_control` breakpoint：

```typescript
// 最多 4 个 cache_control breakpoint（Anthropic API 限制）
// 分配策略：
// 1. 先计算 messages 中已有的 cache_control 数量
// 2. 剩余 slot 分配给最后一个非 deferred tool
// 3. 再分配给最后一个 system block

lastCacheableTool.cache_control = { type: 'ephemeral' }
lastSystemBlock.cache_control = { type: 'ephemeral' }
```

### 本项目现状

本项目在 `types/api/anthropic.ts` 中定义了 `cache_control` 类型，但不会自动注入。
客户端需要自行在 payload 中添加 `cache_control`。

### 建议

作为代理，应在转发请求时自动为 tools 和 system 添加 `cache_control`，这样所有客户端
都能受益于 prompt 缓存，而无需各自实现。

实现要点：
- 计算已有 breakpoint 数量（messages 中的 `cache_control`）
- 在剩余 slot 内标记最后一个 tool 和最后一个 system block
- 尊重客户端已设置的 `cache_control`，不重复添加
- 跳过 `defer_loading: true` 的 tool（不能有 cache_control）

## 2. Tool Search (Server-Side) — P1

### GHC 行为

当启用 tool search 时，GHC 向 tools 列表中添加一个特殊的 `tool_search_tool_regex` 工具：

```typescript
// server-side tool search
finalTools.push({
  name: 'tool_search_tool_regex',
  type: 'tool_search_tool_regex_20251119',
  defer_loading: false
})
```

支持的模型：`claude-sonnet-4.5`, `claude-sonnet-4.6`, `claude-opus-4.5`, `claude-opus-4.6`

工具搜索的流事件类型：
- `server_tool_use` — 服务端发起工具搜索请求
- `tool_search_tool_result` — 返回匹配的工具引用列表

### 本项目现状

已在 `features.ts` 中实现 `modelSupportsToolSearch()`，
但只支持 `claude-opus-4.5` 和 `claude-opus-4.6`。
未在请求构建中注入 tool search 工具。

**差距**: 缺少 Sonnet 4.5/4.6 支持，且未在请求中自动注入 tool search 工具。

### 建议

1. 扩展 `modelSupportsToolSearch()` 支持 Sonnet 4.5/4.6
2. 在 `request-preparation.ts` 中检测并注入 tool search 工具
3. 透传 `tool_search_tool_result` 流事件（作为代理应直接透传）

## 3. Tool Deferral — P1

### GHC 行为

当 tool search 启用时，GHC 将"不常用"的工具标记为 `defer_loading: true`：

```typescript
const isDeferred = toolSearchEnabled
  && isAllowedConversationAgent
  && !isSubagent
  && !toolDeferralService.isNonDeferredTool(tool.function.name)

anthropicTool = { ...anthropicTool, defer_loading: isDeferred ? true : undefined }
```

这优化了 prompt 缓存命中率：非 deferred 工具定义被缓存，deferred 工具只在 tool search 发现后加载。

### 本项目现状

未实现。

### 建议

作为代理，可以：
- 方案 A：透传客户端已设置的 `defer_loading` 标记
- 方案 B：基于配置的"核心工具列表"自动标记

建议先实现方案 A（透传），再考虑方案 B。

## 4. Trailing Assistant Message Guard — P1

### GHC 行为

```typescript
// Messages API 要求对话以 user message 结尾
// 尾随 assistant 消息会被当作 prefill 请求（不支持），返回 400
if (lastMessage && lastMessage.role === 'assistant') {
  messagesResult.messages.push({
    role: 'user',
    content: [{ type: 'text', text: 'Please continue.' }],
  })
}
```

### 本项目现状

`sanitize.ts` 中有消息清洗管道，但未明确处理这个场景。

### 建议

在 sanitize 管道中添加尾随 assistant 消息检测和修复。

## 5. Tool Result Content Type Filtering — P0

### GHC 行为

tool_result 内容块只允许 `text`、`image`、`document` 类型：

```typescript
const validContent = toolContent.filter(c =>
  (c.type === 'text' || c.type === 'image' || c.type === 'document')
  && !(c.type === 'text' && c.text.trim() === '')
)
```

### 本项目现状

透传客户端内容，未做过滤。

### 建议

在 sanitize 管道中添加 tool_result 内容类型过滤。

## 6. Image URL → base64 转换

### GHC 行为

支持两种图片格式：
- `data:image/...;base64,...` → 转为 Anthropic `image.source.type: 'base64'`
- `https://...` → 转为 Anthropic `image.source.type: 'url'`

### 本项目现状

作为代理透传，由客户端确保格式正确。✅ 不需要改动。

## 7. Document (PDF) 支持

### GHC 行为

支持 `application/pdf` 类型的 document block，仅 Anthropic 模型支持。

### 本项目现状

透传处理，不需要特殊逻辑。✅

## 影响评估

| 项目 | 优先级 | 工作量 | 收益 |
|------|--------|--------|------|
| cache_control 自动注入 | P0 | 中 | 显著降低 token 成本 |
| tool result content 过滤 | P0 | 小 | 防止 400 错误 |
| trailing assistant guard | P1 | 小 | 防止 400 错误 |
| tool search 注入 | P1 | 中 | 解锁工具搜索功能 |
| tool deferral 透传 | P1 | 小 | prompt 缓存优化 |
