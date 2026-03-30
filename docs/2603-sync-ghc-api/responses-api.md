# OpenAI Responses API

## GHC 的 Responses API 实现 (`responsesApi.ts`)

## 1. Context Management (Compaction) — P1

### GHC 行为

Responses API 有独立的 context management 机制 — compaction（压缩）：

```typescript
// 不支持 compaction 的模型
const modelsWithoutResponsesContextManagement = new Set(['gpt-5', 'gpt-5.1', 'gpt-5.2'])

if (contextManagementEnabled && !modelsWithoutResponsesContextManagement.has(endpoint.family)) {
  const compactThreshold = endpoint.modelMaxPromptTokens > 0
    ? Math.floor(endpoint.modelMaxPromptTokens * 0.9)
    : 50000
  body.context_management = [{
    type: 'compaction',
    compact_threshold: compactThreshold  // 90% of max prompt tokens
  }]
}
```

当 context 超过阈值时，服务端返回一个 `compaction` 类型的 output item，包含 `encrypted_content`。
后续请求需要将此 item 放入 input 中替代被压缩的历史消息。

流事件处理：
```typescript
case 'response.output_item.done':
  if (chunk.item.type === 'compaction') {
    onProgress({
      text: '',
      contextManagement: {
        type: 'compaction',
        id: compactionItem.id,
        encrypted_content: compactionItem.encrypted_content,
      }
    })
  }
```

### 本项目现状

`responses-client.ts` 透传请求，未添加 context management。

### 建议

作为代理有两种策略：
- **透传**: 如果客户端自己管理 compaction → 不需要改动
- **代理注入**: 自动添加 `context_management`，并在响应中透传 compaction 事件

建议采用透传策略，因为客户端（如 Claude Code）自己管理上下文窗口。

但如果未来要做服务端 context 管理，可以参考 GHC 的实现。

## 2. Stateful Marker / previous_response_id — P1

### GHC 行为

Responses API 返回 `response.id`，GHC 将其作为 `statefulMarker` 保存。
下次请求时通过 `previous_response_id` 字段传递，让服务端维护对话状态：

```typescript
// 构建请求时
return { input, previous_response_id: previousResponseId }

// 收到响应时
case 'response.completed':
  onProgress({ text: '', statefulMarker: chunk.response.id })
```

这避免了在每次请求中重新发送完整的对话历史。

### 本项目现状

`normalizeResponsesCallIds` 配置只处理 `call_` → `fc_` 的 ID 前缀转换，
未处理 `previous_response_id` 的管理。

### 建议

作为代理，客户端（如 Claude Code）会自己传递 `previous_response_id`，我们只需透传。✅
目前不需要额外工作。

## 3. Reasoning (Thinking) 在 Responses API — P2

### GHC 行为

```typescript
body.reasoning = {
  effort: 'medium',               // 客户端可指定
  summary: summaryConfig,          // 配置控制
}
body.include = ['reasoning.encrypted_content']
```

GHC 还处理 `reasoning` 类型的 output item：
- `response.reasoning_summary_text.delta` — thinking 文本增量
- `response.output_item.done` (type: 'reasoning') — thinking 完成

### 本项目现状

透传 reasoning 相关字段。✅

### 建议

确保 `include: ['reasoning.encrypted_content']` 在 Responses API 请求中被透传。
如果客户端不设置，考虑是否自动添加。

## 4. Truncation 配置 — P2

### GHC 行为

```typescript
body.truncation = configService.getConfig(ConfigKey.Advanced.UseResponsesApiTruncation)
  ? 'auto'
  : 'disabled'
```

### 本项目现状

由 `auto-truncate` 模块自己管理截断逻辑。

### 建议

不需要改动，本项目有自己的截断策略。✅

## 5. prompt_cache_key — P2

### GHC 行为

```typescript
if (promptCacheKeyEnabled && options.conversationId) {
  body.prompt_cache_key = `${options.conversationId}:${endpoint.family}`
}
```

这告诉服务端用特定的 key 缓存 prompt，同一 conversation 的后续请求可以复用。

### 本项目现状

未实现。

### 建议

如果要优化 Responses API 的响应速度，可以考虑从请求中提取 conversation ID
并自动设置 `prompt_cache_key`。但这需要客户端传递 conversation ID，
或从请求上下文中推断。P2。

## 6. Verbosity 控制 — P2

### GHC 行为

```typescript
function getVerbosityForModelSync(model): 'low' | 'medium' | 'high' | undefined {
  if (model.family === 'gpt-5.1' || model.family === 'gpt-5-mini') {
    return 'low'
  }
  return undefined
}

body.text = verbosity ? { verbosity } : undefined
```

### 本项目现状

未实现。

### 建议

P2。如果客户端传入 `text.verbosity` 则透传，不需要自动添加。

## 影响评估

| 项目 | 优先级 | 工作量 | 收益 |
|------|--------|--------|------|
| context management 理解 | P1 | 仅文档 | 为未来 context 管理做准备 |
| prompt_cache_key | P2 | 小 | 响应速度优化 |
| verbosity 透传 | P2 | 极小 | 完整性 |
