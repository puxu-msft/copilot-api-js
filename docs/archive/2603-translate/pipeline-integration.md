# Pipeline 集成

## Handler 路由判断

在 `handleChatCompletion()`（`src/routes/chat-completions/handler.ts`）中添加路由分支。

### Endpoint Fallback 语义

`isEndpointSupported()`（`src/lib/models/endpoint.ts:45`）在 `model?.supported_endpoints` **缺失时返回 `true`**：

```typescript
export function isEndpointSupported(model: Model | undefined, endpoint: string): boolean {
  if (!model?.supported_endpoints) return true  // legacy/unknown → 全部视为支持
  return model.supported_endpoints.includes(endpoint)
}
```

因此：
- **Legacy 模型**（无 `supported_endpoints` 字段）：`isEndpointSupported(CHAT_COMPLETIONS)` 返回 true → **始终走直连**
- **`selectedModel === undefined`**（模型不在 `/models` 列表中）：同上 → **始终走直连**
- **翻译路径仅在模型显式声明 `supported_endpoints` 且不含 `/chat/completions` 但含 `/responses` 时触发**

### 路由逻辑

```typescript
export async function handleChatCompletion(c: Context) {
  // ... 现有逻辑：resolveModelName, processOpenAIMessages, sanitize, max_tokens ...

  const selectedModel = state.modelIndex.get(originalPayload.model)

  // 直连优先：legacy/unknown 模型默认走这里（isEndpointSupported 对缺失 supported_endpoints 返回 true）
  if (isEndpointSupported(selectedModel, ENDPOINT.CHAT_COMPLETIONS)) {
    return executeRequest({ c, payload, originalPayload, selectedModel, reqCtx })
  }

  // 翻译路径：仅当模型显式声明了 supported_endpoints 且不含 /chat/completions 时到达此处
  if (isResponsesSupported(selectedModel)) {
    return executeRequestViaResponses({ c, payload, originalPayload, selectedModel, reqCtx })
  }

  // 模型显式声明了 supported_endpoints 但两个端点都不含
  throw new HTTPError(
    `Model "${originalPayload.model}" supports neither /chat/completions nor /responses`,
    400,
  )
}
```

**关键：** sanitize、system prompt、max_tokens 默认值等操作在路由判断**之前**完成，两条路径共享这些预处理。

## FormatAdapter 设计

翻译路径创建一个新的 `FormatAdapter<ChatCompletionsPayload>`，其 `execute()` 内部封装翻译逻辑。

```typescript
function createTranslatedAdapter(
  selectedModel: Model | undefined,
  headersCapture: HeadersCapture,
  reqCtx: RequestContext,
): FormatAdapter<ChatCompletionsPayload> {
  return {
    format: "openai-chat-completions",  // 对外仍是 CC

    sanitize: (p) => sanitizeOpenAIMessages(p),  // CC 格式 sanitizer

    execute: async (ccPayload) => {
      // 1. CC → Responses
      const { payload: responsesPayload, droppedParams } = translateChatCompletionsToResponses(ccPayload)
      if (droppedParams.length > 0) {
        consola.debug(`[CC→Responses] Dropped: ${droppedParams.join(", ")}`)
      }

      // 2. normalizeCallIds (if enabled)
      const finalPayload = state.normalizeResponsesCallIds
        ? normalizeCallIds(responsesPayload)
        : responsesPayload

      // 3. 调用上游 /responses
      const result = await executeWithAdaptiveRateLimit(
        () => createResponses(finalPayload, {
          resolvedModel: selectedModel,
          headersCapture,
          onPrepared: ({ wire, headers }) => {
            reqCtx.setAttemptWireRequest({
              model: wire.model,
              messages: extractInputItems(wire.input),  // ← 见下方"wireRequest.messages"章节
              payload: wire,
              headers,
              format: "openai-responses",
            })
          },
        })
      )

      // 4. 翻译回 CC
      if (!ccPayload.stream) {
        const ccResponse = translateResponsesResponseToCC(result.result as ResponsesResponse)
        return { result: ccResponse, queueWaitMs: result.queueWaitMs }
      }

      // 流式：包装为已翻译的 AsyncGenerator<ServerSentEventMessage>
      // 注意：translator.translate() 遇到 response.failed/error 会抛异常
      // 异常从 generator 传播到 handleStreamingResponse() 的 catch → reqCtx.fail()
      const translator = createStreamTranslator({
        includeUsage: ccPayload.stream_options?.include_usage ?? false,
      })
      const translatedStream = translateResponsesStream(
        result.result as AsyncIterable<ServerSentEventMessage>,
        translator,
      )
      return { result: translatedStream, queueWaitMs: result.queueWaitMs }
    },

    logPayloadSize: (p) => logPayloadSizeInfo(p, selectedModel),
  }
}
```

### 设计要点

1. **`format` 为 `"openai-chat-completions"`** — pipeline 的 `setAttemptEffectiveRequest()` 记录的 format 是 CC。对 history UI 透明。

2. **`wireRequest.format` 为 `"openai-responses"`** — attempt 级别记录实际发送格式，便于调试。利用现有 `onPrepared` 回调模式。

3. **非流式翻译在 execute 内完成** — pipeline 返回的 `result` 已是 `ChatCompletionResponse`，handler 的 `handleNonStreamingResponse()` 直接使用。

4. **流式翻译返回 `AsyncGenerator<ServerSentEventMessage>`** — handler 的 `handleStreamingResponse()` 的迭代逻辑完全不变。翻译后的 chunk 已经是 CC 格式。

5. **流式失败通过异常传播** — translator 遇到 `response.failed`/`error` 抛出异常，传播到 handler 的 catch 块，走 `reqCtx.fail()` + error SSE 的正确路径。

## wireRequest.messages：已有系统性问题

### 问题

`WireRequest.messages` 用于 `toHistoryEntry()` 计算 `wireRequest.messageCount` 并存储 wire 级的消息列表。但 **Responses 格式的 wire payload 没有 `messages` 字段**，它的对话数据在 `input` 中。

现有代码中的问题：

| Handler | `wireRequest.messages` 填充 | `messageCount` 结果 |
|---------|---------------------------|-------------------|
| Anthropic (`messages/handler.ts:183`) | `wire.messages` | **正确** |
| Chat Completions (`chat-completions/handler.ts:145`) | `wire.messages` | **正确** |
| **Responses** (`responses/pipeline.ts:38`) | **`[]`** | **恒为 0** |
| **Responses WS** (`responses/ws.ts:154`) | **`[]`** | **恒为 0** |

这不是翻译层引入的新问题。现有的 Responses handler 和 WS handler **已经**在产出 `messageCount: 0` 的 history entries。

`messageCount` 被消费的地方：
- `toHistoryEntry()` → `wireRequest.messageCount`（`context/request.ts:307`）
- `toHistoryEntry()` → `attempts[].effectiveMessageCount`（`context/request.ts:324`）
- `error-persistence.ts` → 错误 dump 中的 `wire.messageCount`（`context/error-persistence.ts:67`）
- `EntrySummary.messageCount`（`history/entries.ts:57`，取自 `request.messages`，不是 wire）

### 修复方案

为 Responses 格式的 `WireRequest.messages` 填充 `input` items，使 `messageCount` 反映实际的对话条目数。

```typescript
/** 从 Responses payload 的 input 提取 items 作为 wireRequest.messages */
function extractInputItems(input: string | Array<ResponsesInputItem>): Array<unknown> {
  if (typeof input === "string") return [{ type: "message", role: "user", content: input }]
  return input
}
```

#### 修复范围（3 处）

**1. 翻译路径**（本次新增）：

```typescript
// 翻译层 adapter 的 onPrepared
reqCtx.setAttemptWireRequest({
  model: wire.model,
  messages: extractInputItems(wire.input),
  payload: wire,
  headers,
  format: "openai-responses",
})
```

**2. 现有 Responses HTTP handler**（`src/routes/responses/pipeline.ts:38`）：

```diff
 onPrepared?.({
   model: typeof wire.model === "string" ? wire.model : p.model,
-  messages: [],
+  messages: extractInputItems(wire.input),
   payload: wire,
   headers,
   format: "openai-responses",
 })
```

**3. 现有 Responses WS handler**（`src/routes/responses/ws.ts:154-156`）：

使用相同的 `createResponsesAdapter()` ，修复 pipeline.ts 即可同时修复 WS。

#### `extractInputItems` 的位置

放在 `src/routes/responses/pipeline.ts`，与 `normalizeCallIds()` 同级。三个消费者（翻译路径 adapter、HTTP handler adapter、WS handler adapter）都从这里导入。

#### 修复后的 messageCount 语义

| Handler | `messageCount` 含义 |
|---------|-------------------|
| Anthropic | 消息数 |
| Chat Completions | 消息数 |
| **Responses** | **input item 数**（修复后） |
| **翻译路径** | **input item 数**（修复后） |

对 Responses 格式，`input` items 就是 "messages" 的语义等价物——每个 item 是一个对话条目（message、function_call、function_call_output 等）。`messageCount` 的名称不完美但足够传达信息量。

## Retry 策略

复用 CC 直连路径的三个策略：

```typescript
const strategies = [
  createNetworkRetryStrategy<ChatCompletionsPayload>(),
  createTokenRefreshStrategy<ChatCompletionsPayload>(),
  createAutoTruncateStrategy<ChatCompletionsPayload>({
    truncate: (p, model, truncOpts) => autoTruncateOpenAI(p, model, truncOpts),
    resanitize: (p) => sanitizeOpenAIMessages(p),
    isEnabled: () => state.autoTruncate,
    label: "Completions(→Responses)",
  }),
]
```

**auto-truncate 工作原理：**
- 上游返回 413 或 token 限制错误
- pipeline 调用 `autoTruncateOpenAI()` 在 CC payload 上截断
- pipeline 用截断后的 CC payload 重新调用 `adapter.execute()`
- `execute()` 内部再次翻译为 Responses 格式发送

截断始终在 CC 格式上操作，与直连路径完全一致。

## History Recording

### Attempt Tracking

Pipeline 自动为每次尝试调用 `setAttemptEffectiveRequest()`（`src/lib/request/pipeline.ts:108-117`）：

```typescript
requestContext.setAttemptEffectiveRequest({
  model: typeof p.model === "string" ? p.model : "",
  resolvedModel: model,
  messages: Array.isArray(p.messages) ? p.messages : [],
  payload: effectivePayload,
  format: adapter.format,  // "openai-chat-completions"
})
```

翻译层通过 `onPrepared` 回调额外设置 `wireRequest`（format 为 `"openai-responses"`）。

### History Entry 结构

`toHistoryEntry()`（`src/lib/context/request.ts:245-329`）的实际行为：

- `entry.effectiveRequest` 和 `entry.wireRequest` 在**顶层**，取自**最终 attempt**（`_attempts.at(-1)`）
- `entry.attempts[]` 只保留**摘要**：`index`, `strategy`, `durationMs`, `error`, `truncation`, `sanitization`, `effectiveMessageCount`

```
entry:
  endpoint: "openai-chat-completions"        ← 客户端视角
  request: { CC format }                     ← 原始请求

  effectiveRequest:                          ← 顶层，最终 attempt 的
    format: "openai-chat-completions"
    model: "..."
    messageCount: N                          ← CC messages 数量
    messages: [...]
    payload: { CC format }

  wireRequest:                               ← 顶层，最终 attempt 的
    format: "openai-responses"               ← 实际发送格式
    model: "..."
    messageCount: M                          ← input items 数量（修复后）
    messages: [...]                           ← input items（修复后）
    payload: { Responses format }
    headers: { ... }

  response: { CC format usage/content }

  attempts: [                                ← 摘要列表
    { index: 0, durationMs, effectiveMessageCount: N },
    { index: 1, strategy: "auto-truncate", durationMs, truncation: {...} },
  ]
```

注意：`attempts[]` 中**没有**完整的 `effectiveRequest`/`wireRequest`，只有 `effectiveMessageCount` 摘要。完整数据只在顶层保留最终一次。

## TUI 集成

翻译路径在 TUI 中添加标签：

```typescript
if (tuiLogId) {
  tuiLogger.updateRequest(tuiLogId, { tags: ["via-responses"] })
}

// 如果有被丢弃的参数，也标记
if (droppedParams.length > 0) {
  tuiLogger.updateRequest(tuiLogId, { tags: ["dropped-params"] })
}
```

## 完整执行流程

```
handleChatCompletion()
  │
  ├─ resolveModelName()
  ├─ processOpenAIMessages()          ← system prompt overrides (可能 append 尾部 system)
  ├─ setOriginalRequest()
  ├─ sanitizeOpenAIMessages()
  ├─ set max_tokens default
  │
  ├─ isEndpointSupported(CHAT_COMPLETIONS)?
  │   └─ YES → executeRequest()       ← 直连（legacy/unknown 模型也走这里）
  │
  └─ isResponsesSupported()?          ← 仅显式声明 supported_endpoints 的模型能到这
      └─ YES → executeRequestViaResponses()
           │
           ├─ createTranslatedAdapter()
           ├─ strategies (network, token, auto-truncate)
           │
           ├─ executeRequestPipeline()
           │   │
           │   ├─ beginAttempt()
           │   ├─ setAttemptEffectiveRequest()  ← CC format
           │   ├─ adapter.execute(ccPayload)
           │   │   ├─ translateChatCompletionsToResponses()
           │   │   │   └─ splitInstructionsAndConversation()  ← 全量扫描 system
           │   │   ├─ normalizeCallIds()
           │   │   ├─ createResponses()
           │   │   │   └─ prepareResponsesRequest()  ← builds headers
           │   │   │       └─ onPrepared → setAttemptWireRequest()
           │   │   │           └─ messages: extractInputItems(wire.input)
           │   │   └─ 非流式: translateResponsesResponseToCC()
           │   │      流式:   translateResponsesStream()
           │   │              └─ response.failed/error → throw (不是 yield)
           │   │
           │   ├─ on 413 → autoTruncateOpenAI(ccPayload)
           │   │   └─ retry → adapter.execute(truncatedCcPayload)
           │   │
           │   └─ return { response (CC format) }
           │
           ├─ setHttpHeaders(headersCapture)
           │
           ├─ non-streaming?
           │   └─ handleNonStreamingResponse()  ← 完全复用
           └─ streaming?
               └─ handleStreamingResponse()     ← 完全复用
                   └─ catch → reqCtx.fail()     ← 翻译器异常在此处理
```
