# Pipeline 集成

## 概述

翻译层如何集成到现有的 handler → pipeline → client 架构中。核心原则：**对 handler 的改动最小化，翻译逻辑封装在 adapter 内部。**

## Handler 路由判断

在 `handleChatCompletion()` 中，当模型不支持 `/chat/completions` 但支持 `/responses` 时，切换到翻译路径。

```typescript
// src/routes/chat-completions/handler.ts

export async function handleChatCompletion(c: Context) {
  // ... 现有逻辑：model resolve, system prompt, sanitize ...

  const selectedModel = state.modelIndex.get(originalPayload.model)

  // 路由判断
  if (isEndpointSupported(selectedModel, ENDPOINT.CHAT_COMPLETIONS)) {
    // 直连路径（现有逻辑不变）
    return executeRequest({ c, payload, originalPayload, selectedModel, reqCtx })
  }

  if (isResponsesSupported(selectedModel)) {
    // 翻译路径
    return executeRequestViaResponses({ c, payload, originalPayload, selectedModel, reqCtx })
  }

  // 都不支持
  throw new HTTPError(`Model "${originalPayload.model}" supports neither /chat/completions nor /responses`, 400)
}
```

**重要：** sanitize、system prompt、max_tokens 默认值等操作在路由判断**之前**完成，翻译路径复用这些结果。

## FormatAdapter 设计

翻译路径使用独立的 `FormatAdapter`，其 `execute` 内部包含翻译逻辑。

```typescript
function createTranslatedAdapter(
  selectedModel: Model | undefined,
  headersCapture: HeadersCapture,
  reqCtx: RequestContext,
): FormatAdapter<ChatCompletionsPayload> {
  return {
    format: "openai-chat-completions",  // 对外仍是 CC 格式

    // sanitize 在 CC 格式上操作（与直连路径相同）
    sanitize: (p) => sanitizeOpenAIMessages(p),

    execute: async (p) => {
      // 1. 翻译 CC → Responses
      const { payload: responsesPayload, droppedParams } = translateChatCompletionsToResponses(p)
      if (droppedParams.length > 0) {
        consola.debug(`[CC→Responses] Dropped unsupported params: ${droppedParams.join(", ")}`)
      }

      // 2. 可选：normalizeCallIds
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
              messages: [],
              payload: wire,
              headers,
              format: "openai-responses",  // wire 格式是 responses
            })
          },
        })
      )

      // 4. 翻译响应回 CC 格式
      if (!p.stream) {
        const responsesResponse = result.result as ResponsesResponse
        const ccResponse = translateResponsesResponseToCC(responsesResponse)
        return { result: ccResponse, queueWaitMs: result.queueWaitMs }
      }

      // 流式：返回翻译后的 AsyncIterable
      const translator = createResponsesToCCStreamTranslator({
        includeUsage: p.stream_options?.include_usage ?? false,
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

**关键设计点：**

1. **`format` 仍为 `"openai-chat-completions"`**：对 pipeline、history、TUI 透明。Pipeline 不知道底层用了 /responses。

2. **wire request 记录 `format: "openai-responses"`**：history 的 attempt detail 中记录实际的 wire 格式，便于调试。

3. **非流式翻译在 execute 内完成**：pipeline 收到的 `result` 已经是 CC 格式，handler 无需额外处理。

4. **流式翻译返回已翻译的 AsyncIterable**：handler 的 `handleStreamingResponse` 收到的事件已经是 CC chunk 格式的 SSE，现有的流处理逻辑无需修改。

## 流式翻译管道

流式翻译需要将 Responses 的 SSE 事件流转换为 CC 的 SSE 事件流：

```typescript
async function* translateResponsesStream(
  upstream: AsyncIterable<ServerSentEventMessage>,
  translator: ReturnType<typeof createResponsesToCCStreamTranslator>,
): AsyncGenerator<ServerSentEventMessage> {
  for await (const rawEvent of upstream) {
    if (!rawEvent.data || rawEvent.data === "[DONE]") continue

    try {
      const event = JSON.parse(rawEvent.data) as ResponsesStreamEvent

      // 翻译事件
      const chunks = translator.translate(event)

      // 输出翻译后的 chunks 为 SSE 事件
      for (const chunk of chunks) {
        yield {
          data: JSON.stringify(chunk),
          event: "message",
        } as ServerSentEventMessage
      }
    } catch {
      // 跳过不可解析的事件
    }
  }

  // 发送 [DONE] 标记
  yield { data: "[DONE]" } as ServerSentEventMessage
}
```

## Retry 策略

翻译路径使用与直连路径**相同**的 retry 策略：

```typescript
const strategies = [
  createNetworkRetryStrategy<ChatCompletionsPayload>(),
  createTokenRefreshStrategy<ChatCompletionsPayload>(),
  createAutoTruncateStrategy<ChatCompletionsPayload>({
    truncate: (p, model, truncOpts) =>
      autoTruncateOpenAI(p, model, truncOpts),
    resanitize: (p) => sanitizeOpenAIMessages(p),
    isEnabled: () => state.autoTruncate,
    label: "Completions(→Responses)",  // 标签区分
  }),
]
```

**auto-truncate 工作原理：**
- Truncate 操作在 CC 格式的 payload 上执行
- Pipeline 用截断后的 CC payload 重新调用 `adapter.execute()`
- `execute()` 内部再次翻译为 Responses 格式发送
- 这确保了截断逻辑与直连路径完全一致

## History Recording

### RequestContext 生命周期

翻译路径的 RequestContext 使用 `endpoint: "openai-chat-completions"` —— 对 history UI 和 TUI 而言，这就是一个普通的 CC 请求。

但 attempt 级别的 wire request 记录了实际的 `format: "openai-responses"`，用于调试。

```
History entry:
  endpoint: "openai-chat-completions"      ← 客户端视角
  originalRequest: { CC format }           ← 客户端发送的
  attempts[0]:
    effectiveRequest: { CC format }        ← sanitize/truncate 后的 CC payload
    wireRequest:
      format: "openai-responses"           ← 实际发送的格式
      payload: { Responses format }        ← 实际的 wire payload
  responseData: { CC format usage/content} ← 翻译回的结果
```

### Stream Accumulator

流式翻译路径需要同时维护：
1. **ResponsesStreamAccumulator**：累积上游 Responses 事件，供 history 记录原始响应
2. **OpenAIStreamAccumulator**：累积翻译后的 CC chunks，供 `buildOpenAIResponseData()` 构建 responseData

由于翻译后的流已经是 CC 格式，handler 的现有 `accumulateOpenAIStreamEvent()` 可以直接使用。

## TUI 集成

翻译路径的 TUI 标签可以添加 `via-responses` 提示：

```typescript
if (tuiLogId) {
  tuiLogger.updateRequest(tuiLogId, { tags: ["via-responses"] })
}
```

## Endpoint 判断逻辑

路由判断的优先级：

```
1. 模型支持 /chat/completions  → 直连（首选）
2. 模型支持 /responses         → 翻译
3. 都不支持                     → 400 错误
```

使用现有的 `isEndpointSupported()` 和 `isResponsesSupported()` 函数。

**边界情况：** 如果模型同时支持两者，**始终选择直连**。翻译路径仅在必要时使用，因为：
- 直连没有翻译开销
- 直连支持 CC 独有的参数（stop, seed 等）
- 直连的流式格式更简单

## 完整执行流程图

```
handleChatCompletion(c)
  │
  ├─ resolveModelName()
  ├─ processOpenAIMessages()        ← system prompt override
  ├─ sanitizeOpenAIMessages()       ← orphan filter, system-reminder removal
  ├─ set max_tokens default
  │
  ├─ isEndpointSupported(CHAT_COMPLETIONS)?
  │   └─ YES → executeRequest()     ← 现有直连路径
  │
  └─ isResponsesSupported()?
      └─ YES → executeRequestViaResponses()
           │
           ├─ createTranslatedAdapter()
           │   └─ execute():
           │       ├─ translateChatCompletionsToResponses(ccPayload)
           │       ├─ normalizeCallIds() (if enabled)
           │       ├─ createResponses(responsesPayload)
           │       └─ translateResponsesResponseToCC() or translateResponsesStream()
           │
           ├─ executeRequestPipeline()
           │   ├─ adapter.execute()  ← 上面的 adapter
           │   ├─ on error → strategy.handle()
           │   │   ├─ NetworkRetry → retry with same CC payload
           │   │   ├─ TokenRefresh → refresh token, retry
           │   │   └─ AutoTruncate → truncate CC payload, re-execute
           │   └─ return { response (CC format), ... }
           │
           ├─ non-streaming? → handleNonStreamingResponse()  ← 复用现有
           └─ streaming?     → handleStreamingResponse()     ← 复用现有
```

**handler 层的 `handleNonStreamingResponse()` 和 `handleStreamingResponse()` 完全不变** —— adapter 已经在内部完成了格式翻译。
