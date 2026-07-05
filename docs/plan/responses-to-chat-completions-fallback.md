# 计划 v3：引入 PR#3 的 Responses → Chat Completions Fallback

> v3 修订（在 v2 基础上吸收第 3 轮 subagent review 的 11 项新发现 + 用户 4 项决策）

## Context

[PR#3](https://github.com/puxu-msft/copilot-api-js/pull/3) 解决一个客户端兼容性缺口：当客户端（如 Codex CLI）只会通过 `/v1/responses` 协议说话，但目标模型（Gemini、纯聊天 Claude 等）**不支持** Copilot 上游的 `/responses` 端点时，当前实现会直接 400 报错。PR#3 让这类请求**回退到上游 `/chat/completions`**，并双向翻译 payload 与 stream。

意图全面采纳。但 PR 原实现存在若干 bug 和**完全缺失多轮对话延续**，本计划是按本项目设计原则的彻底改写：在 PR 基础上修复 11+ 处问题、补全 `previous_response_id` 上下文重建。

## 现有翻译模块与 PR#3 关系

[src/lib/openai/translate/](src/lib/openai/translate/) 现有 3 个文件，全部覆盖 **"客户端 CC → 上游 Responses"** 方向。PR#3 的 3 个新函数全部覆盖**反方向**（"客户端 Responses → 上游 CC"），与现有代码**无重叠**。

## 落点与改动清单

### 新增

| 文件 | 说明 |
|---|---|
| `src/lib/openai/translate/responses-to-cc-request.ts` | 3 个 export + 内部 helper（移植自 PR，按下方调整） |
| `src/routes/responses/conversation-rebuild.ts` | 从 history 重建 `previous_response_id` 的对话上下文 |
| `src/routes/responses/fallback.ts` | `executeResponsesViaChatCompletions()` 主体 + `shouldForceChatCompletionsFallback()` |
| `tests/unit/responses-to-cc-request.test.ts` | 单元测试 |
| `tests/unit/responses-conversation-rebuild.test.ts` | 对话重建单元测试 |

> 把 fallback 单独放 `fallback.ts` 而非塞进 `handler.ts`：handler.ts 已 320 行，再加 fallback 会突破 500 行；单独文件高内聚（与 `handleDirectResponses` 的复杂度对等）。

### 修改

| 文件 | 说明 |
|---|---|
| `src/lib/openai/translate/index.ts` | 追加 3 个 re-export |
| `src/routes/responses/handler.ts` | 分发改为有条件 fallback，**保留所有原注释**；不再内含 fallback 实现 |
| `src/types/api/openai-chat-completions.ts` | 给 `ChatCompletionsPayload` 加 `reasoning_effort?: "low"\|"medium"\|"high"` 字段（为 Codex/o-series 转发用） |
| `README.md` | 采纳 PR 的 SEO 文案 |
| `package.json` | 采纳 keywords 重排与新增，**保留尾换行** |

### 不动

- 现有 translate 文件
- `handleDirectResponses` 内部逻辑及其文档注释
- WebSocket Responses handler（`ws.ts`）

## 完整修订清单

### 🔴 Critical（必须修复）

| ID | 问题 | 修复 |
|---|---|---|
| **C2** | `translateCCToResponsesResponse` 当 `choices: []` 时 `choice.message` 崩溃 | 加 guard，无 choice 时抛 `HTTPError("upstream returned empty choices", 502, ...)` |
| **C5a** | `ccResponse.id.replace("chatcmpl-", "resp_")` 若上游 id 不以 `chatcmpl-` 开头则 id 不带 `resp_` 前缀 | ID 不在翻译函数内生成；**由 handler 注入** `responseId` / `itemId` / `clientModel` 参数；同一 exchange 流/非流路径共用 |
| **C5b** | 流分支未调用 `setSessionId` + `registerResponseSession` | 流路径**开始时**（首个 `response.created` 后）立即 register（修 NEW-G race） |
| **新 #6 finish_reason** | 截断/过滤被掩盖成 completed | 映射 `length` → `status:"incomplete"` + `incomplete_details.reason:"max_output_tokens"`；`content_filter` → 同 + `reason:"content_filter"`；其他 → `completed` |
| **新 #1 model=""** | `response.created` 事件 `model: ""` | handler 注入 `clientModel`（请求传入的模型名）作为初值；首个 chunk 修正后续事件 |
| **NEW-A 翻译异常路径** | 翻译抛 HTTPError 时反复 catch 不清晰 | **翻译位置移入 `adapter.execute`**——handler 收到的 `pipelineResult.response` 已是 Responses 形态；pipeline 的 try/catch 自然 cover |
| **NEW-B developer 角色** | 重建 messages 前置时未把 developer 角色与 system 同视为 prelude | prelude bucket = `role in {"system", "developer"}` |

### 🟡 重要（首版即修）

| ID | 问题 | 修复 |
|---|---|---|
| **C11 / Q3** | 流式 fallback 上游 CC 不发 usage 时 token 记成 0 | `stream_options` **merge** 策略：`{ ...client.stream_options, include_usage: true }`；保留客户端其他字段 |
| **新 #4 conversation rebuild** | fallback 上游 CC stateless | 新增 `conversation-rebuild.ts`；handler 在分发到 fallback 前调用，prepend 到 ccPayload.messages |
| **Codex reasoning_effort** | `payload.reasoning?.effort` 丢失 | 翻译时 `cc.reasoning_effort = payload.reasoning?.effort`（CC payload 类型新增此字段） |
| **新 #5 空 text-only message** | 纯 tool-only 响应仍 emit 空 message | 仅当 `textPartStarted` 时才 emit message lifecycle 事件 |
| **NEW-E ID 强度** | `Math.random().toString(36)` 可能 padded zeros | 使用 `crypto.randomUUID().replace(/-/g,"").slice(0,11)`（Node/Bun 均原生支持） |

### 🟢 一致性 / 清理

| ID | 问题 | 处理 |
|---|---|---|
| **B1** | `chatCompletionResponseToStreamChunks` 死代码 + 配套测试 | 删除 helper + 删除该单元测试 |
| **B3 isGoogle** | 内联无注释 | 抽 `shouldForceChatCompletionsFallback(model)` + 详细注释，硬编码 `["Google"]` 名单 |
| **C9 fixStreamEventIds** | 文档化为 design decision | "fallback path generates internally-consistent IDs from a single responseId; the global fixResponsesStreamIds flag is intentionally bypassed" |
| **C10 TUI metrics** | 流 fallback 不更新 metrics | 补 `streamBytesIn`/`streamEventsIn` 更新 |
| **新 #3 input.length** | `p.input` undefined 时崩溃 | `const count = typeof p.input === "string" ? 1 : (Array.isArray(p.input) ? p.input.length : 0)` |
| **PR 删尾换行 / 删注释** | 不复刻 | — |
| **`developer_instructions` 嗅探** | 不符合类型权威 | 删除；spec 已有 `role: "developer"` 在 input |
| **Math.random 三处** | 抽 helper | `genShortId()` 使用 crypto |

## 实现细节

### 1. `responses-to-cc-request.ts`

```ts
// Public API — IDs and clientModel injected by handler
export function translateResponsesToChatCompletions(payload: ResponsesPayload): ChatCompletionsPayload
export function translateCCToResponsesResponse(
  ccResponse: ChatCompletionResponse,
  ctx: { responseId: string; itemId: string; clientModel: string },
): ResponsesResponse
export async function* translateCCStreamToResponsesStream(
  ccStream: AsyncIterable<ServerSentEventMessage>,
  ctx: { responseId: string; itemId: string; clientModel: string },
): AsyncGenerator<{ event: string; data: string }, void, unknown>

// File-scoped helpers (verbatim list, not exposed)
function ccFinishReasonToResponsesStatus(reason: FinishReason | null): {
  status: "completed" | "incomplete",
  incompleteReason?: string,
}
function translateInputItemToMessages(item): Array<Message>
function translateContentParts(content, role): string | Array<ContentPart> | null
function translateToolsToCC(tools): Array<Tool>
function translateToolChoiceToCC(choice): ChatCompletionsPayload["tool_choice"]
function translateResponseFormatToCC(format): ResponseFormat
function responsesStreamEvent(event, data): { event: string; data: string }
function parseChatCompletionStreamData(data): Record<string, unknown> | null
function createSyntheticResponsesResponse(opts): ResponsesResponse
```

**关键调整对 PR**：
- 删除 `chatCompletionResponseToStreamChunks` + 配套测试
- 删除 `developer_instructions` 嗅探
- 删除 ID 内部生成（改为 ctx 参数注入）
- 删除空 text-only message lifecycle emit
- 强制 `stream === true` 时 merge `stream_options: { ...existing, include_usage: true }`
- 翻译 `reasoning.effort` → `reasoning_effort`
- 翻译 `finish_reason` → `status` + `incomplete_details`
- 翻译 `previous_response_id` 字段：**不传递给 CC**（CC 没有这个概念，重建在 handler 层完成）

**注释保留**：在每个被 drop 的字段（`reasoning.summary`、`store`、`metadata`、`include`、`truncation`、`context_management`、`text.verbosity`）处加 `// NOTE: dropped — Responses-only field, no /chat/completions equivalent`

### 2. `conversation-rebuild.ts` 新模块

```ts
import { getSessionEntries, type HistoryEntry, type MessageContent } from "~/lib/history"
import type { ContentPart, Message } from "~/types/api/openai-chat-completions"

/** Cap entries we replay — prevents unbounded context for very long sessions */
/**
 * Cap entries we replay — prevents unbounded context for very long sessions.
 * 50 turns @ ~2KB each ≈ 100KB, comfortably under typical CC context budgets
 * once instructions + tools land on top.
 */
const MAX_REPLAY_ENTRIES = 50
/** Overscan to compensate for entries filtered out (failed / wrong endpoint). */
const REPLAY_QUERY_BUFFER = 20

/**
 * Markers `responsesInputToMessages` stores for non-message Responses items
 * (item_reference, reasoning, compaction) — informational placeholders, not
 * real conversation turns. Skip during rebuild.
 */
const MARKER_PATTERN = /^\[(reasoning|item_reference|.+):\s.+\]$/

/**
 * Reconstruct CC-shaped conversation history from a stored session.
 *
 * Codex CLI and similar Responses clients use `previous_response_id` to chain
 * turns, expecting the proxy to maintain server-side conversation state. When
 * the proxy falls back to stateless /chat/completions upstream, it must replay
 * the prior conversation manually. This function transforms recorded
 * HistoryEntry chain into a CC Message[] suitable for prepending.
 *
 * Returns [] for: missing sessionId, unknown session, no completed entries.
 */
export function rebuildConversationMessages(sessionId: string | undefined): Array<Message>
```

**算法（方案 C 精细版）**：

```ts
if (!sessionId) return []
// Overscan: filter may drop entries; load enough to fill MAX_REPLAY_ENTRIES after filtering.
const session = getSessionEntries(sessionId, { limit: MAX_REPLAY_ENTRIES + REPLAY_QUERY_BUFFER })
if (session.entries.length === 0) return []

// Filter: only Responses-format entries, only successfully completed
const replayable = session.entries.filter((e) =>
  e.endpoint === "openai-responses"
  && e.state === "completed"
  && e.response?.success !== false,
)

// Final cap by recency (overscan may still leave more than max after filter)
const capped = replayable.slice(-MAX_REPLAY_ENTRIES)

const messages: Array<Message> = []
for (const entry of capped) {
  const turnIncrement = extractTurnIncrement(entry.request.messages ?? [])
  for (const m of turnIncrement) messages.push(toCCMessage(m))
  if (entry.response?.content) {
    messages.push(toCCMessage(entry.response.content))
  }
}
return messages

/**
 * Extract "what was new this turn" — last contiguous run of non-assistant
 * messages, also skipping informational marker messages
 * (reasoning/item_reference) that `responsesInputToMessages` stores as
 * placeholder assistant strings.
 */
function extractTurnIncrement(stored: Array<MessageContent>): Array<MessageContent> {
  const nonSystem = stored.filter((m) => m.role !== "system" && m.role !== "developer")
  const suffix: Array<MessageContent> = []
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const msg = nonSystem[i]
    // Skip marker placeholders — they're not real assistant turns and
    // shouldn't break the walk-back.
    if (msg.role === "assistant" && typeof msg.content === "string" && MARKER_PATTERN.test(msg.content)) {
      continue
    }
    if (msg.role === "assistant") break
    suffix.unshift(msg)
  }
  return suffix
}

/** Convert stored MessageContent to CC Message (mostly identity; image source needs back-convert) */
function toCCMessage(stored: MessageContent): Message {
  return {
    role: stored.role as Message["role"],
    content: normalizeContent(stored.content),
    ...(stored.tool_calls && { tool_calls: stored.tool_calls.map((t) => ({
      id: t.id,
      type: t.type as "function",
      function: t.function,
    })) }),
    ...(stored.tool_call_id && { tool_call_id: stored.tool_call_id }),
    ...(stored.name && { name: stored.name }),
  }
}

function normalizeContent(content: MessageContent["content"]): string | Array<ContentPart> | null {
  if (content === null || typeof content === "string") return content
  if (!Array.isArray(content)) return null

  const parts: Array<ContentPart> = []
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block) {
      const b = block as Record<string, unknown>
      if (b.type === "text" && typeof b.text === "string") {
        parts.push({ type: "text", text: b.text })
      } else if (b.type === "image") {
        // Anthropic-shaped: { source: { type: "url", url } } → CC image_url
        const src = b.source as { type?: string; url?: string } | undefined
        if (src?.url) parts.push({ type: "image_url", image_url: { url: src.url } })
      }
      // Skip tool_use / tool_result / thinking — these come through as separate
      // messages via the role-based extraction; embedding them in content is an
      // Anthropic-API convention not preserved in CC. The extraction loop above
      // already split them into proper assistant/tool messages where applicable.
    }
  }
  return parts.length > 0 ? parts : ""
}
```

### 3. `fallback.ts` 新模块

```ts
/** Vendors whose /responses upstream is broken or absent on Copilot; force /chat/completions */
const FORCE_CC_VENDORS: ReadonlyArray<string> = ["Google"]

/**
 * Decide whether to bypass /responses even when the model claims support.
 *
 * Rationale: Copilot's /responses upstream returns 5xx for several Gemini SKUs
 * (PR#3 reporter observed this). Until upstream stabilizes, force fallback for
 * known-broken vendors. Update FORCE_CC_VENDORS when fixed.
 */
export function shouldForceChatCompletionsFallback(model: Model | undefined): boolean {
  return Boolean(model?.vendor && FORCE_CC_VENDORS.includes(model.vendor))
}

export async function executeResponsesViaChatCompletions(opts: {
  c: Context
  payload: ResponsesPayload
  reqCtx: RequestContext
  selectedModel: Model | undefined
}) {
  // 1. Rebuild prior conversation from session history
  const historyMessages = rebuildConversationMessages(opts.reqCtx.sessionId)

  // 2. Translate payload to CC
  const ccPayload = translateResponsesToChatCompletions(opts.payload)

  // 3. Prepend history (after system+developer prelude, before current input)
  if (historyMessages.length > 0) {
    const prelude = ccPayload.messages.filter((m) => m.role === "system" || m.role === "developer")
    const current = ccPayload.messages.filter((m) => m.role !== "system" && m.role !== "developer")
    ccPayload.messages = [...prelude, ...historyMessages, ...current]
  }

  // 4. Stable IDs for this exchange
  const responseId = `resp_${genShortId()}`
  const itemId = `item_${genShortId()}`
  const clientModel = opts.payload.model

  // 5. Adapter — translation INSIDE execute (NEW-A)
  const headersCapture: HeadersCapture = {}
  const adapter: FormatAdapter<ResponsesPayload> = {
    format: "openai-responses",
    sanitize: (p) => ({ payload: p, blocksRemoved: 0, systemReminderRemovals: 0 }),
    logPayloadSize: (p) => {
      const count = typeof p.input === "string" ? 1 : (Array.isArray(p.input) ? p.input.length : 0)
      consola.debug(`Responses-fallback payload: ${count} input item(s), model: ${p.model}`)
    },
    execute: async (_currentResponsesPayload) => {
      const { result: ccResult, queueWaitMs } = await executeWithAdaptiveRateLimit(() =>
        createChatCompletions(ccPayload, {
          resolvedModel: opts.selectedModel,
          headersCapture,
          onPrepared: ({ wire, headers }) => {
            opts.reqCtx.setAttemptWireRequest({
              model: typeof wire.model === "string" ? wire.model : opts.payload.model,
              messages: Array.isArray(wire.messages) ? wire.messages : [],
              payload: wire,
              headers,
              format: "openai-chat-completions",
            })
          },
        }),
      )

      if (!opts.payload.stream) {
        // Translate to Responses shape INSIDE adapter so pipeline sees Responses result
        return {
          result: translateCCToResponsesResponse(ccResult as ChatCompletionResponse, {
            responseId, itemId, clientModel,
          }),
          queueWaitMs,
        }
      }

      const translatedStream = translateCCStreamToResponsesStream(
        ccResult as AsyncIterable<ServerSentEventMessage>,
        { responseId, itemId, clientModel },
      )
      return { result: translatedStream, queueWaitMs }
    },
  }

  const strategies = createResponsesStrategies()
  try {
    const pipelineResult = await executeRequestPipeline({
      adapter, strategies, payload: opts.payload, originalPayload: opts.payload,
      model: opts.selectedModel, maxRetries: 1, requestContext: opts.reqCtx,
    })

    opts.reqCtx.setHttpHeaders(headersCapture)
    const response = pipelineResult.response

    if (!opts.payload.stream) {
      // Non-stream path
      const responsesResponse = response as ResponsesResponse
      if (!opts.reqCtx.sessionId) opts.reqCtx.setSessionId(responsesResponse.id)
      registerResponseSession(responsesResponse.id, opts.reqCtx.sessionId)
      opts.reqCtx.complete({
        success: true,
        model: responsesResponse.model,
        usage: { /* mapped from responsesResponse.usage */ },
        stop_reason: responsesResponse.status,
        content: responsesOutputToContent(responsesResponse.output),
      })
      return opts.c.json(responsesResponse)
    }

    // Stream path — eager register at first response.created (NEW-G)
    if (!opts.reqCtx.sessionId) opts.reqCtx.setSessionId(responseId)
    registerResponseSession(responseId, opts.reqCtx.sessionId)

    opts.reqCtx.transition("streaming")
    return streamSSE(opts.c, async (stream) => {
      const clientAbort = new AbortController()
      stream.onAbort(() => clientAbort.abort())

      const acc = createResponsesStreamAccumulator()
      const idleTimeoutMs = state.streamIdleTimeout * 1000
      let bytesIn = 0
      let eventsIn = 0

      try {
        const guarded = guardSseIterable(response as AsyncIterable<SseFrame>, {
          idleTimeoutMs,
          getAbortSignal: () => combineAbortSignals(getShutdownSignal(), clientAbort.signal),
        })
        for await (const rawEvent of guarded) {
          if (rawEvent.data && rawEvent.data !== "[DONE]") {
            bytesIn += rawEvent.data.length
            eventsIn++
            if (opts.reqCtx.tuiLogId) {
              tuiLogger.updateRequest(opts.reqCtx.tuiLogId, { streamBytesIn: bytesIn, streamEventsIn: eventsIn })
            }
            try {
              const event = JSON.parse(rawEvent.data) as ResponsesStreamEvent
              accumulateResponsesStreamEvent(event, acc)
              await stream.writeSSE({ event: rawEvent.event ?? event.type, data: rawEvent.data })
            } catch (err) {
              consola.debug(`[responses-fallback] unparseable SSE frame:`, err)
            }
          }
        }
        // Session id already registered eagerly above; refresh in case accumulator
        // captured a different upstream id (it shouldn't, but be defensive).
        const responseData = buildResponsesResponseData(acc, opts.payload.model)
        opts.reqCtx.complete(responseData)
      } catch (error) {
        consola.error("[Responses-fallback] Stream error:", error)
        opts.reqCtx.fail(acc.model || opts.payload.model, error)
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            error: {
              message: error instanceof Error ? error.message : String(error),
              type: error instanceof StreamIdleTimeoutError ? "timeout_error" : "server_error",
            },
          }),
        })
      }
    })
  } catch (error) {
    opts.reqCtx.setHttpHeaders(headersCapture)
    opts.reqCtx.fail(opts.payload.model, error)
    throw error
  }
}
```

### 4. `handler.ts` 改动结构

替换 [handler.ts:101-106](src/routes/responses/handler.ts#L101-L106)：

```ts
const selectedModel = state.modelIndex.get(payload.model)
const useFallback = !isResponsesSupported(selectedModel)
  || shouldForceChatCompletionsFallback(selectedModel)

if (useFallback && !isEndpointSupported(selectedModel, ENDPOINT.CHAT_COMPLETIONS)) {
  const msg = `Model "${payload.model}" does not support /responses or /chat/completions`
  throw new HTTPError(msg, 400, msg)
}
```

`handleResponses` 入口末尾：
```ts
if (useFallback) {
  if (tuiLogId) tuiLogger.updateRequest(tuiLogId, { tags: ["via-chat-completions-fallback"] })
  return executeResponsesViaChatCompletions({ c, payload, reqCtx, selectedModel })
}
return handleDirectResponses({ c, payload, reqCtx })
```

### 5. 关键复用

- [createChatCompletions](src/lib/openai/chat-completions-client.ts#L38)
- [executeWithAdaptiveRateLimit](src/lib/adaptive-rate-limiter.ts)
- [executeRequestPipeline](src/lib/request/pipeline.ts)
- [createResponsesStrategies](src/routes/responses/pipeline.ts#L78)
- [guardSseIterable](src/lib/stream.ts) / [combineAbortSignals](src/lib/stream.ts)
- [createResponsesStreamAccumulator](src/lib/openai/responses-stream-accumulator.ts) / [accumulateResponsesStreamEvent](src/lib/openai/responses-stream-accumulator.ts)
- [buildResponsesResponseData](src/lib/request/recording.ts)
- [getSessionEntries](src/lib/history/sessions.ts#L93)
- [resolveResponseSessionId](src/lib/history/sessions.ts#L57) / [registerResponseSession](src/lib/history/sessions.ts#L63)
- [responsesOutputToContent](src/lib/openai/responses-conversion.ts#L139)

### 6. 不变量与设计决策（明确文档化）

- `processResponsesInstructions` 在 fallback 决策**之前**应用 → fallback 透明继承 config-yaml overrides
- `reqCtx.setOriginalRequest` 在分发前调用 → history 始终记录原始 Responses payload
- history `effectiveRequest.format: "openai-responses"` + `wireRequest.format: "openai-chat-completions"` → UI 上可见格式差异（feature）
- fallback 自行生成 `resp_*` ID，**不应用** `fixStreamEventIds`（内部 ID 已自洽）
- 对话重建是 best-effort：找不到 session 或 history 已清理时 fallback 仍继续，`consola.debug` 记录
- session 注册**流路径开始时**就 register（修 NEW-G race），非流路径在结束时 register
- 头部已有的 `getSessionIdFromHeaders(...) ?? resolveResponseSessionId(payload.previous_response_id)` 优先级保持不变：客户端 header > previous_response_id

## 测试

### `tests/unit/responses-to-cc-request.test.ts`
- `translateResponsesToChatCompletions`：
  - instructions → system message
  - 简单 text input、multimodal、function_call、function_call_output
  - tools / tool_choice (string + function 形式)
  - response_format (json_object / json_schema)
  - `stream === true` 自动 merge `stream_options.include_usage: true`，并保留客户端原有字段
  - max_output_tokens → max_tokens
  - `reasoning.effort` → `reasoning_effort`
- `translateCCToResponsesResponse`：
  - 基础映射、tool_calls 回写、usage 映射
  - `finish_reason: "length"` → `status: "incomplete"` + `incomplete_details.reason: "max_output_tokens"`
  - 空 choices → 抛 HTTPError(502)
  - 注入的 responseId/itemId/clientModel 体现在输出
- `translateCCStreamToResponsesStream`：
  - text deltas 生命周期事件序列
  - 序号单调递增
  - tool_call deltas 正确 emit
  - 纯 tool-only 响应（无 text）不 emit 空 message
  - `response.created` 携带 clientModel
  - 上游无 usage chunk 时 `response.completed.response.usage === null`

### `tests/unit/responses-conversation-rebuild.test.ts`
- 空 sessionId / 不存在 sessionId → `[]`
- delta 模式 session（每 entry 仅 1 user）→ 完整 history
- full-history 模式 session（entry N 含 entries 1~N-1）→ 仅 last suffix 提取，无重复
- 跳过 `state !== "completed"` 的 entry
- 跳过 `response.success === false` 的 entry
- 过滤 `endpoint !== "openai-responses"` 的 entry
- 最近 50 截断
- Anthropic 风格 `{type:"image", source:{type:"url"}}` → CC `{type:"image_url"}`
- tool_calls 字段完整传递

### 集成测试（追加到现有 component 测试）
- fallback path 端到端：Gemini 模型请求 `/v1/responses` 非流 → 返回合法 Responses response
- fallback path 流式：Gemini 模型 `/v1/responses` stream → SSE 事件序列合法
- fallback path 多轮：第二轮带 `previous_response_id` → ccPayload.messages 包含历史

## 验证

```bash
bun run typecheck
bunx eslint --cache src/lib/openai/translate/ src/routes/responses/ \
  tests/unit/responses-to-cc-request.test.ts \
  tests/unit/responses-conversation-rebuild.test.ts
bun test tests/unit/responses-to-cc-request.test.ts
bun test tests/unit/responses-conversation-rebuild.test.ts
bun test tests/unit/responses-to-cc.test.ts             # 现有反向测试
bun test tests/unit/responses-to-cc-stream.test.ts       # 同上
bun test tests/component/                                # 包含 handler 集成
bun test tests/unit/openai-request-preparation.test.ts   # max_tokens remap 兼容
```
