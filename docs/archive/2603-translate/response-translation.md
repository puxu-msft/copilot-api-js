# 响应翻译：Responses → Chat Completions

## 概述

将上游 Responses API 的响应翻译回 Chat Completions 格式返回给客户端。两种模式：
- **非流式**：`ResponsesResponse` → `ChatCompletionResponse`
- **流式**：`ResponsesStreamEvent` 事件流 → `ChatCompletionChunk` SSE 流

翻译在 `adapter.execute()` 内部完成。handler 层收到的已经是 CC 格式。

## 非流式响应翻译

### ResponsesResponse → ChatCompletionResponse

```typescript
{                                          {
  id: "resp_abc",                            id: "resp_abc",
  object: "response",                        object: "chat.completion",
  created_at: 1711600000,                    created: 1711600000,
  status: "completed",                       model: "gpt-4o",
  model: "gpt-4o",                           choices: [{
  output: [                                    index: 0,
    { type:"message", content:[              message: {
      { type:"output_text", text:"Hi" }        role: "assistant",
    ]},                                         content: "Hi",
    { type:"function_call",                     tool_calls: [{
      call_id:"fc_1", name:"s",                  id: "fc_1", type: "function",
      arguments:"{}" }                           function: { name:"s", arguments:"{}" }
  ],                                          }],
  usage: {                                  },
    input_tokens: 100,                      finish_reason: "stop",
    output_tokens: 50,                    }],
    total_tokens: 150,                    usage: {
    input_tokens_details: {                 prompt_tokens: 100,
      cached_tokens: 20                     completion_tokens: 50,
    },                                      total_tokens: 150,
    output_tokens_details: {                prompt_tokens_details: { cached_tokens: 20 },
      reasoning_tokens: 10                  completion_tokens_details: { reasoning_tokens: 10 },
    }                                     },
  }                                     }
}
```

### output → message 提取

`ResponsesOutputItem[]` 合并为单个 CC `ResponseMessage`：

```typescript
function extractMessageFromOutput(output: ResponsesOutputItem[]): ResponseMessage {
  const textParts: string[] = []
  const toolCalls: ToolCall[] = []

  for (const item of output) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") textParts.push(part.text)
        if (part.type === "refusal") textParts.push(part.refusal)  // 直接输出，不加标记
      }
    }
    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      })
    }
    // reasoning items 静默忽略（CC 无对应概念）
  }

  return {
    role: "assistant",
    content: textParts.join("") || null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
  }
}
```

**refusal 处理统一策略：** 非流式和流式都直接输出 refusal 原文，不加 `[Refusal: ...]` 标记包装。这与 CC 原生行为一致（CC 的 `message.refusal` 字段是独立字段，但翻译层将其折叠进 `content`，保持文本原样即可）。

### status → finish_reason

```typescript
function mapFinishReason(
  status: ResponsesResponse["status"],
  output: ResponsesOutputItem[],
  incompleteDetails?: { reason: string } | null,
): FinishReason {
  const hasToolCalls = output.some(item => item.type === "function_call")
  if (hasToolCalls) return "tool_calls"

  switch (status) {
    case "completed":   return "stop"
    case "incomplete":
      if (incompleteDetails?.reason === "max_output_tokens") return "length"
      if (incompleteDetails?.reason === "content_filter") return "content_filter"
      return "length"  // unknown reason fallback
    case "failed":
    case "cancelled":   return "stop"
    default:            return "stop"
  }
}
```

### usage 映射

```typescript
// Responses usage field names     → CC usage field names
// input_tokens                    → prompt_tokens
// output_tokens                   → completion_tokens
// total_tokens                    → total_tokens
// input_tokens_details.cached     → prompt_tokens_details.cached_tokens
// output_tokens_details.reasoning → completion_tokens_details.reasoning_tokens
```

### 错误处理

`status === "failed"` 时抛出 `HTTPError`，不返回 CC 格式响应。

## 流式响应翻译

### 格式差异

| 维度 | Chat Completions | Responses |
|------|-------------------|-----------|
| 事件模型 | 分块 delta | 语义生命周期事件 |
| 事件类型 | 统一 `chat.completion.chunk` | 30+ 种语义事件类型 |
| 工具调用 | 嵌套在 `delta.tool_calls[]` | 独立 `function_call_arguments.delta` 事件 |
| 完成信号 | `finish_reason` 非空 | `response.completed` 事件 |
| usage | 可选最终 chunk | `response.completed` 中携带 |

### 事件映射表

```
Responses Event                           → CC Chunk 输出
──────────────────────────────────────────────────────────────────
response.created                          → { delta: { role: "assistant" } }
response.in_progress                      → (不输出)

response.output_item.added (message)      → (不输出)
response.content_part.added               → (不输出)
response.output_text.delta                → { delta: { content: delta } }
response.output_text.done                 → (不输出)
response.content_part.done                → (不输出)
response.output_item.done (message)       → (不输出)

response.output_item.added (function_call)→ { delta: { tool_calls: [{ index, id, type, function:{name} }] } }
response.function_call_arguments.delta    → { delta: { tool_calls: [{ index, function:{arguments} }] } }
response.function_call_arguments.done     → (不输出)
response.output_item.done (function_call) → (不输出)

response.completed                        → { delta:{}, finish_reason } + optional usage chunk
response.incomplete                       → { delta:{}, finish_reason } (映射 incomplete_details)
response.failed                           → ⚠ 抛出异常（不是 yield error SSE）
error                                     → ⚠ 抛出异常（不是 yield error SSE）

response.refusal.delta                    → { delta: { content: delta } } (直接输出，不加标记)
response.reasoning_summary_*              → (不输出 — CC 无 reasoning)
```

### 流式失败路径：必须抛异常

#### 问题：yield error SSE 不会触发 `reqCtx.fail()`

`handleStreamingResponse()`（`src/routes/chat-completions/handler.ts:278-371`）的行为：

- for 循环（第 314-351 行）直接转发所有 SSE 事件，**包括 error event**
- 循环正常结束后调用 `reqCtx.complete()`（第 353-354 行）
- **只有 catch 块**才调用 `reqCtx.fail()`（第 355-370 行）

因此，如果翻译器对 `response.failed` 只是 yield 一个 error SSE event：
1. handler 会转发给客户端
2. 循环继续，最终 `reqCtx.complete()` — **history 记为成功**
3. 还可能发 `[DONE]`

#### 解决方案：translator 抛异常

翻译器的 `AsyncGenerator` 在遇到 `response.failed` 或 `error` 事件时应**抛出异常**：

```typescript
// 在 translateResponsesStream generator 中：
case "response.failed": {
  const errorMsg = event.response.error?.message ?? "Upstream response failed"
  throw new Error(errorMsg)  // 传播到 handleStreamingResponse 的 catch
}

case "error": {
  throw new Error(event.message ?? "Upstream error")
}
```

这样 `raceIteratorNext()` 会将异常传播到 `handleStreamingResponse()` 的 catch 块，走正确的 `reqCtx.fail()` + error SSE + 流结束路径。

### `response.incomplete` 的 finish_reason 映射

**非流式和流式统一处理 `incomplete_details.reason`：**

```typescript
function mapIncompleteFinishReason(response: ResponsesResponse): FinishReason {
  const reason = response.incomplete_details?.reason
  if (reason === "max_output_tokens") return "length"
  if (reason === "content_filter") return "content_filter"
  return "length"  // unknown reason fallback
}
```

流式中 `response.incomplete` 事件携带完整的 `response` 对象，可以访问 `incomplete_details`。

### 流翻译状态机

```typescript
interface StreamTranslatorState {
  /** 已发送首 chunk（含 role:"assistant"） */
  sentFirstChunk: boolean
  /** 响应 ID */
  responseId: string
  /** 模型名 */
  model: string
  /** output_index → tool_call_index 映射 */
  toolCallIndexMap: Map<number, number>
  /** 下一个可用的 tool_call index */
  nextToolCallIndex: number
  /** output_index → call_id */
  toolCallIds: Map<number, string>
  /** 是否需要 usage chunk */
  includeUsage: boolean
}
```

状态追踪要点：

1. **首 chunk role** — CC 流第一个 chunk 必须含 `delta: { role: "assistant" }`。在 `response.created` 时发送。

2. **tool_call index** — CC 的 `delta.tool_calls[].index` 是序号。Responses 用 `output_index`。需维护 `output_index → tool_call_index` 映射。

3. **finish_reason** — 仅最后一个 choice chunk 带 `finish_reason`，之前都是 `null`。对应 `response.completed`/`response.incomplete`。

4. **usage chunk** — 当 `include_usage=true` 时，流末尾发独立的 usage-only chunk（`choices: []`）。

### chunk 构建

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
```

### 流 AsyncGenerator 封装

翻译后的流仍是 `AsyncGenerator<ServerSentEventMessage>`，handler 的 `handleStreamingResponse()` 可直接消费：

```typescript
async function* translateResponsesStream(
  upstream: AsyncIterable<ServerSentEventMessage>,
  translator: StreamTranslator,
): AsyncGenerator<ServerSentEventMessage> {
  for await (const rawEvent of upstream) {
    if (!rawEvent.data || rawEvent.data === "[DONE]") continue

    const event = JSON.parse(rawEvent.data) as ResponsesStreamEvent

    // response.failed 和 error 事件会让 translate() 抛异常
    // 异常传播到 handleStreamingResponse() 的 catch，走 reqCtx.fail() 路径
    const chunks = translator.translate(event)

    for (const chunk of chunks) {
      yield { data: JSON.stringify(chunk), event: "message" } as ServerSentEventMessage
    }
  }
  yield { data: "[DONE]" } as ServerSentEventMessage
}
```

### 公开 API

```typescript
/** 非流式 */
export function translateResponsesResponseToCC(response: ResponsesResponse): ChatCompletionResponse

/** 流式翻译器工厂 */
export function createStreamTranslator(opts: { includeUsage: boolean }): {
  /** 翻译单个事件。返回 0~N 个 chunks。response.failed/error 时抛异常。 */
  translate(event: ResponsesStreamEvent): ChatCompletionChunk[]
  getState(): StreamTranslatorState
}
```
