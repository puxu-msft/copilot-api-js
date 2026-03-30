# 响应翻译：Responses → Chat Completions

## 概述

将上游 Responses API 的响应翻译回 Chat Completions 格式。分为两种模式：
- **非流式**：`ResponsesResponse` → `ChatCompletionResponse`
- **流式**：`ResponsesStreamEvent` 事件流 → `ChatCompletionChunk` SSE 流

## 非流式响应翻译

### 顶层字段映射

```typescript
// Responses Response:
{
  id: "resp_abc123",
  object: "response",
  created_at: 1711600000,
  status: "completed",
  model: "gpt-4o",
  output: [...],
  usage: { input_tokens, output_tokens, total_tokens, ... },
  ...
}

// → Chat Completion Response:
{
  id: "resp_abc123",
  object: "chat.completion",
  created: 1711600000,
  model: "gpt-4o",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "...",           // 从 output 提取
      tool_calls: [...],        // 从 output 提取
    },
    finish_reason: "stop",      // 从 status/output 映射
    logprobs: null,
  }],
  usage: {
    prompt_tokens: ...,
    completion_tokens: ...,
    total_tokens: ...,
    prompt_tokens_details: { cached_tokens: ... },
    completion_tokens_details: { reasoning_tokens: ... },
  },
}
```

### output → message 提取

Responses 的 `output` 是一个 `ResponsesOutputItem[]` 数组，需要合并为单个 `message` 对象。

```typescript
function extractMessageFromOutput(output: ResponsesOutputItem[]): ResponseMessage {
  const textParts: string[] = []
  const toolCalls: ToolCall[] = []

  for (const item of output) {
    switch (item.type) {
      case "message": {
        for (const part of item.content) {
          if (part.type === "output_text") textParts.push(part.text)
          if (part.type === "refusal") textParts.push(`[Refusal: ${part.refusal}]`)
        }
        break
      }
      case "function_call": {
        toolCalls.push({
          id: item.call_id,       // 使用 call_id 作为 CC 的 tool_call id
          type: "function",
          function: { name: item.name, arguments: item.arguments },
        })
        break
      }
      case "reasoning": {
        // Reasoning summary 不映射到 CC message content
        // （CC 没有 reasoning 概念，静默忽略）
        break
      }
    }
  }

  return {
    role: "assistant",
    content: textParts.join("") || null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
  }
}
```

**注意：** `responsesOutputToContent()` 已经实现了类似的 output 提取逻辑，可以参考。但该函数返回 `MessageContent`（history 格式），翻译层需要返回 `ResponseMessage`（CC 格式），类型略有不同。

### status → finish_reason 映射

Responses 的 `status` 需要结合 output 内容映射为 CC 的 `finish_reason`：

```typescript
function mapFinishReason(
  status: ResponsesResponse["status"],
  output: ResponsesOutputItem[],
  incompleteDetails?: { reason: string } | null,
): FinishReason {
  // 如果 output 包含 function_call，finish_reason 应为 "tool_calls"
  const hasToolCalls = output.some(item => item.type === "function_call")
  if (hasToolCalls) return "tool_calls"

  switch (status) {
    case "completed":
      return "stop"
    case "incomplete": {
      if (incompleteDetails?.reason === "max_output_tokens") return "length"
      if (incompleteDetails?.reason === "content_filter") return "content_filter"
      return "length"  // 默认 incomplete → length
    }
    case "failed":
    case "cancelled":
      return "stop"    // 异常情况，回退到 stop
    default:
      return "stop"
  }
}
```

### usage 映射

```typescript
function mapUsage(usage: ResponsesUsage | null): ChatCompletionUsage | undefined {
  if (!usage) return undefined
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.input_tokens_details?.cached_tokens !== undefined && {
      prompt_tokens_details: { cached_tokens: usage.input_tokens_details.cached_tokens },
    }),
    ...(usage.output_tokens_details?.reasoning_tokens !== undefined && {
      completion_tokens_details: { reasoning_tokens: usage.output_tokens_details.reasoning_tokens },
    }),
  }
}
```

### 错误响应处理

当 `status === "failed"` 时，Responses 的 `error` 字段包含错误详情。翻译层应将此转换为 HTTP 错误抛出，而非返回 CC 格式的响应：

```typescript
if (response.status === "failed" && response.error) {
  throw new HTTPError(response.error.message, 500, response.error.message)
}
```

## 流式响应翻译

### 设计挑战

两种 API 的流式格式有**根本性差异**：

| 维度 | Chat Completions | Responses |
|------|-------------------|-----------|
| 事件模型 | 分块 delta（每个 chunk 是增量） | 语义生命周期事件 |
| 事件类型 | 统一 `chat.completion.chunk` | 30+ 种语义事件类型 |
| 工具调用 | 嵌套在 `delta.tool_calls[]` | 独立的 `function_call_arguments.delta` 事件 |
| 完成信号 | `finish_reason` 非空 | `response.completed` 事件 |
| usage | 可选的最终 chunk（stream_options） | `response.completed` 事件中包含 |

### 事件映射表

```
Responses Event                           → Chat Completions Chunk
──────────────────────────────────────────────────────────────────────────
response.created                          → 首个 chunk: { delta: { role: "assistant" } }
response.in_progress                      → (消费，不输出)
response.output_item.added (message)      → (消费，不输出)
response.content_part.added               → (消费，不输出)
response.output_text.delta                → { delta: { content: delta } }
response.output_text.done                 → (消费，不输出)
response.content_part.done                → (消费，不输出)
response.output_item.done (message)       → (消费，不输出)

response.output_item.added (function_call)→ { delta: { tool_calls: [{ index, id, type:"function",
                                                function: { name, arguments:"" } }] } }
response.function_call_arguments.delta    → { delta: { tool_calls: [{ index,
                                                function: { arguments: delta } }] } }
response.function_call_arguments.done     → (消费，不输出)
response.output_item.done (function_call) → (消费，不输出)

response.completed                        → { delta: {}, finish_reason: "stop" }
                                            + (如果 include_usage) { usage: {...}, choices: [] }
response.failed                           → error SSE event
response.incomplete                       → { delta: {}, finish_reason: "length" }

response.reasoning_summary_text.delta     → (消费，不输出 — CC 无 reasoning 概念)
response.reasoning_summary_*.other        → (消费，不输出)
response.refusal.delta                    → { delta: { content: delta } } (作为普通文本)
error                                     → error SSE event
```

### 流翻译状态机

流式翻译需要维护内部状态，因为 CC chunk 的某些字段依赖 Responses 事件序列中的上下文。

```typescript
interface StreamTranslatorState {
  /** 是否已发送首个 chunk（包含 role: "assistant"） */
  sentFirstChunk: boolean
  /** 响应 ID（从 response.created 获取） */
  responseId: string
  /** 模型名（从 response.created 获取） */
  model: string
  /** 当前 output_index → tool_call_index 映射 */
  toolCallIndexMap: Map<number, number>
  /** 下一个可用的 tool_call index */
  nextToolCallIndex: number
  /** 当前活跃的 function_call call_id（output_index → call_id） */
  toolCallIds: Map<number, string>
  /** usage 数据（从 response.completed 获取） */
  usage: ChatCompletionUsage | null
  /** 是否需要发送 usage chunk */
  includeUsage: boolean
}
```

**关键状态追踪：**

1. **首 chunk role**：CC 流的第一个 chunk 必须包含 `delta: { role: "assistant" }`。在收到 `response.created` 时发送。

2. **tool_call index**：CC 的 `delta.tool_calls[].index` 是工具调用的序号（0, 1, 2...），而 Responses 使用 `output_index` 来标识不同的 output item。需要维护 `output_index → tool_call_index` 映射。

3. **finish_reason 时机**：只有最后一个 choice chunk 带 `finish_reason`，之前都是 `null`。在 `response.completed` / `response.incomplete` 事件时发送。

4. **usage chunk**：当 `include_usage=true` 时，在流末尾发一个特殊的 usage-only chunk（`choices: []`）。

### chunk 构建器

```typescript
function buildChunk(
  state: StreamTranslatorState,
  delta: StreamingDelta,
  finishReason: FinishReason | null = null,
): ChatCompletionChunk {
  return {
    id: state.responseId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
      logprobs: null,
    }],
  }
}

function buildUsageChunk(
  state: StreamTranslatorState,
  usage: ChatCompletionUsage,
): ChatCompletionChunk {
  return {
    id: state.responseId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [],
    usage,
  }
}
```

### 事件翻译核心逻辑

```typescript
/**
 * 翻译单个 Responses 事件为零或多个 CC chunks。
 * 返回 null 表示该事件不产生输出。
 */
function translateEvent(
  event: ResponsesStreamEvent,
  state: StreamTranslatorState,
): ChatCompletionChunk[] | null {
  switch (event.type) {
    case "response.created": {
      state.responseId = event.response.id
      state.model = event.response.model
      // 发送首个 chunk（role only）
      state.sentFirstChunk = true
      return [buildChunk(state, { role: "assistant" })]
    }

    case "response.output_text.delta": {
      return [buildChunk(state, { content: event.delta })]
    }

    case "response.output_item.added": {
      if (event.item.type === "function_call") {
        const tcIndex = state.nextToolCallIndex++
        state.toolCallIndexMap.set(event.output_index, tcIndex)
        const callId = "call_id" in event.item ? event.item.call_id : event.item.id
        state.toolCallIds.set(event.output_index, callId)

        return [buildChunk(state, {
          tool_calls: [{
            index: tcIndex,
            id: callId,
            type: "function",
            function: {
              name: "name" in event.item ? event.item.name : "",
              arguments: "",
            },
          }],
        })]
      }
      return null
    }

    case "response.function_call_arguments.delta": {
      const tcIndex = state.toolCallIndexMap.get(event.output_index)
      if (tcIndex === undefined) return null
      return [buildChunk(state, {
        tool_calls: [{
          index: tcIndex,
          function: { arguments: event.delta },
        }],
      })]
    }

    case "response.completed": {
      const chunks: ChatCompletionChunk[] = []
      const hasToolCalls = state.nextToolCallIndex > 0
      const finishReason = mapStreamFinishReason(event.response, hasToolCalls)

      // Finish chunk
      chunks.push(buildChunk(state, {}, finishReason))

      // Usage chunk (if requested)
      if (state.includeUsage && event.response.usage) {
        chunks.push(buildUsageChunk(state, mapUsage(event.response.usage)!))
      }

      return chunks
    }

    case "response.incomplete": {
      const finishReason = mapIncompleteReason(event.response)
      return [buildChunk(state, {}, finishReason)]
    }

    case "response.failed": {
      // 不生成 chunk，由调用方处理错误
      return null
    }

    case "response.refusal.delta": {
      // Refusal 作为普通 content 输出
      return [buildChunk(state, { content: event.delta })]
    }

    // 所有其他事件：静默消费
    default:
      return null
  }
}
```

### SSE 输出格式

翻译后的 chunks 通过 Hono 的 `streamSSE` 输出：

```typescript
// 每个翻译后的 chunk:
await stream.writeSSE({
  data: JSON.stringify(chunk),
  event: "message",
})

// 流结束标记:
await stream.writeSSE({
  data: "[DONE]",
  event: "message",
})
```

### 错误事件处理

Responses 的 `response.failed` 和 `error` 事件需要翻译为 CC 格式的错误 SSE：

```typescript
// 原 Responses error event:
{ type: "error", message: "...", code: "..." }

// → CC 格式的 error SSE:
await stream.writeSSE({
  event: "error",
  data: JSON.stringify({
    error: {
      message: "...",
      type: "server_error",
    },
  }),
})
```

## 完整翻译函数签名

```typescript
/** 非流式翻译 */
export function translateResponsesResponseToCC(
  response: ResponsesResponse,
): ChatCompletionResponse

/** 创建流式翻译器 */
export function createResponsesToCCStreamTranslator(opts: {
  includeUsage: boolean
}): {
  /** 翻译单个事件，返回要输出的 chunks（可能为空） */
  translate(event: ResponsesStreamEvent): ChatCompletionChunk[]
  /** 获取内部状态（用于 accumulator 和 history） */
  getState(): StreamTranslatorState
}
```

流式翻译器使用工厂函数模式，返回一个有状态的 translator 对象。每次调用 `translate()` 传入一个 Responses 事件，返回零或多个 CC chunks。
