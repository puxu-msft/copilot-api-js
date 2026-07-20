/**
 * Inbound translation: Responses API request → Chat Completions request.
 *
 * Used by the /v1/responses fallback path when the target model doesn't
 * support Copilot's /responses upstream (Gemini, plain-chat Claude, etc.).
 * The fallback handler invokes these three translators to bridge the protocol
 * gap so Responses-only clients (Codex CLI) can still reach those models.
 *
 * Direction (note this is the REVERSE of cc-to-responses.ts):
 *   client Responses payload ─► translateResponsesToChatCompletions ─► upstream CC payload
 *   upstream CC response     ─► translateCCToResponsesResponse      ─► client Responses response
 *   upstream CC SSE stream   ─► translateCCStreamToResponsesStream  ─► client Responses SSE
 *
 * IDs (responseId / itemId) are injected by the handler so the streaming
 * and non-streaming paths share the same exchange ID, enabling correct
 * session registration via registerResponseSession().
 *
 * Tool handling (`translateToolsToCC`): Copilot's `/chat/completions` only
 * accepts function tools, so `custom` (freeform) tools are degraded to function
 * tools and builtin server tools are dropped — both warned, never silent. Known
 * deferred limitation: the response side has no inverse — a degraded custom
 * tool's call comes back as a `function_call` with `{"input":"…"}` JSON args
 * rather than a native `custom_tool_call`, so a client that strictly expects the
 * freeform shape (raw-text input) may not round-trip. The direct `/responses`
 * passthrough is unaffected (custom tools reach the upstream verbatim); this only
 * concerns the CC fallback (model lacks `/responses` support). No real traffic
 * exercises it today, so the inverse is intentionally not built (YAGNI).
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type {
  //
  ChatCompletionResponse,
  ChatCompletionUsage,
  ChatCompletionsPayload,
  ContentPart,
  FinishReason,
  Message,
  ResponseFormat,
  Tool,
} from "~/types/api/openai-chat-completions"
import type {
  //
  ResponsesInputItem,
  ResponsesOutputItem,
  ResponsesPayload,
  ResponsesResponse,
  ResponsesTextFormat,
  ResponsesTool,
  ResponsesToolChoice,
} from "~/types/api/openai-responses"

import { HTTPError } from "~/lib/error"

/** Context injected by the handler so streams/non-streams share IDs for an exchange. */
export interface TranslateExchangeContext {
  /** Stable `resp_xxx` id assigned by the handler (used as Responses response.id). */
  responseId: string
  /** Stable `item_xxx` id for the synthesized message output item. */
  itemId: string
  /**
   * Model name the client requested. Used to populate `response.created.model`
   * before the upstream CC stream's first chunk arrives with its real model name.
   */
  clientModel: string
}

// ============================================================================
// Request translation (Responses → CC)
// ============================================================================

/**
 * Translate an incoming Responses API payload into a Chat Completions payload.
 *
 * Drops Responses-only fields (store, metadata, include, truncation, etc.) — see
 * inline notes. `previous_response_id` is NOT forwarded; conversation history
 * is reconstructed separately by the handler via `rebuildConversationMessages`.
 */
export function translateResponsesToChatCompletions(payload: ResponsesPayload): ChatCompletionsPayload {
  const messages: Array<Message> = []

  // 1. Instructions → system message (config-yaml overrides are applied earlier
  //    by processResponsesInstructions, so payload.instructions already reflects
  //    the final effective system prompt at this point).
  if (payload.instructions) {
    messages.push({ role: "system", content: payload.instructions })
  }

  // 2. Input items → CC messages
  if (typeof payload.input === "string") {
    messages.push({ role: "user", content: payload.input })
  } else if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      messages.push(...translateInputItemToMessages(item))
    }
  }

  const tools = payload.tools ? translateToolsToCC(payload.tools) : undefined
  const toolChoice = payload.tool_choice ? translateToolChoiceToCC(payload.tool_choice) : undefined
  const responseFormat = payload.text?.format ? translateResponseFormatToCC(payload.text.format) : undefined
  const streamOptions = buildStreamOptions(payload)

  // 3. Assemble CC payload — note these intentional drops:
  //   NOTE: payload.reasoning.summary — Responses-only ("auto"/"concise"/"detailed")
  //   NOTE: payload.store              — Responses server-side persistence flag
  //   NOTE: payload.metadata           — Responses-only key-value metadata
  //   NOTE: payload.include            — Responses-only includes (e.g. reasoning.encrypted_content)
  //   NOTE: payload.truncation         — Responses-only truncation mode hint
  //   NOTE: payload.context_management — Responses-only compaction config
  //   NOTE: payload.text.verbosity     — Responses-only output verbosity hint
  //   NOTE: payload.previous_response_id — handled by handler via session rebuild
  return {
    model: payload.model,
    messages,
    ...(payload.stream !== undefined && payload.stream !== null && { stream: payload.stream }),
    ...(payload.temperature !== undefined && payload.temperature !== null && { temperature: payload.temperature }),
    ...(payload.top_p !== undefined && payload.top_p !== null && { top_p: payload.top_p }),
    ...(payload.max_output_tokens !== undefined && payload.max_output_tokens !== null && { max_tokens: payload.max_output_tokens }),
    ...(payload.parallel_tool_calls !== undefined && { parallel_tool_calls: payload.parallel_tool_calls }),
    ...(payload.user !== undefined && { user: payload.user }),
    ...(payload.service_tier !== undefined && { service_tier: payload.service_tier }),
    ...(payload.top_logprobs !== undefined && payload.top_logprobs !== null && { top_logprobs: payload.top_logprobs }),
    ...(payload.reasoning?.effort && { reasoning_effort: payload.reasoning.effort }),
    ...(tools && tools.length > 0 && { tools }),
    ...(toolChoice && { tool_choice: toolChoice }),
    ...(responseFormat && { response_format: responseFormat }),
    ...(streamOptions && { stream_options: streamOptions }),
  }
}

/**
 * When streaming, force `include_usage: true` so upstream emits the final usage
 * chunk — otherwise token accounting silently zeros out. Merge (not overwrite)
 * so any other client-set fields under stream_options survive.
 */
function buildStreamOptions(payload: ResponsesPayload): { include_usage?: boolean } | undefined {
  if (!payload.stream) return undefined
  // ResponsesPayload doesn't declare stream_options, but clients may include it
  // via an extended/untyped object — preserve via spread.
  const existing = (payload as unknown as { stream_options?: Record<string, unknown> }).stream_options ?? {}
  return { ...existing, include_usage: true }
}

// ============================================================================
// Non-streaming response translation (CC → Responses)
// ============================================================================

/**
 * Translate a complete (non-streaming) CC response into a Responses-shaped
 * response. IDs are injected by the caller so they align with the streaming
 * path and session registration.
 */
export function translateCCToResponsesResponse(ccResponse: ChatCompletionResponse, ctx: TranslateExchangeContext): ResponsesResponse {
  const choice = ccResponse.choices[0]
  // Defensive: TS sees Array<NonStreamingChoice> as guaranteed-defined at [0],
  // but real upstreams can return `choices: []` (content filter, certain
  // errored stream flushes) — fail loud rather than crash downstream.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!choice) {
    throw new HTTPError("Upstream chat-completions returned empty choices array", 502, JSON.stringify({ upstream: ccResponse }), ctx.clientModel)
  }

  const message = choice.message
  const contentText = message.content || ""
  const { status, incompleteReason } = ccFinishReasonToResponsesStatus(choice.finish_reason)

  const messageOutput: ResponsesOutputItem = {
    id: ctx.itemId,
    type: "message",
    role: "assistant",
    status: status === "incomplete" ? "incomplete" : "completed",
    content: [{ type: "output_text", text: contentText, annotations: [] }],
  }
  const output: Array<ResponsesOutputItem> = [messageOutput]

  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      output.push({
        type: "function_call",
        id: tc.id,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: "completed",
      })
    }
  }

  return {
    id: ctx.responseId,
    object: "response",
    created_at: ccResponse.created,
    status,
    model: ccResponse.model || ctx.clientModel,
    output,
    usage: ccResponse.usage ? ccUsageToResponsesUsage(ccResponse.usage) : null,
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
    ...(incompleteReason && { incomplete_details: { reason: incompleteReason } }),
  }
}

// ============================================================================
// Streaming translation (CC → Responses)
// ============================================================================

/**
 * One CC SSE frame's worth of translation output (a Responses lifecycle event).
 */
interface ResponsesStreamFrame {
  event: string
  data: string
}

/**
 * A per-frame CC → Responses stream translator. `translate(ccData)` consumes one
 * upstream CC SSE `data` string and returns the Responses events to emit for it;
 * `flush()` emits the closing lifecycle events (output/content/item done +
 * `response.completed`) at stream end.
 *
 * This is the per-frame shape the v4 driver consumes (codec.renderResponse is
 * per-frame); {@link translateCCStreamToResponsesStream} below is a thin
 * whole-stream driver over it, so both paths produce byte-identical output. The
 * `response.created` event is emitted lazily on the first `translate`/`flush`
 * call (matching the legacy generator's "emit created before the loop", incl. the
 * empty-stream case) and carries `ctx.clientModel` since no chunk has updated the
 * model yet at that point.
 */
export interface CCToResponsesStreamTranslator {
  /** Translate one upstream CC SSE `data` string → Responses events (empty for `[DONE]`/unparseable). */
  translate(ccData: string): Array<ResponsesStreamFrame>
  /** Emit the closing lifecycle events at stream end. */
  flush(): Array<ResponsesStreamFrame>
}

/**
 * Build the per-frame CC → Responses stream translator (the codec holds it in its
 * per-request closure for the Responses fallback path).
 *
 * The global `fixResponsesStreamIds` flag is intentionally bypassed — the
 * fallback generates internally-consistent IDs from ctx.
 */
export function createCCToResponsesStreamTranslator(ctx: TranslateExchangeContext): CCToResponsesStreamTranslator {
  const createdAt = Math.floor(Date.now() / 1000)
  const contentParts: Array<string> = []
  const toolCalls = new Map<number, { id: string; callId: string; name: string; arguments: Array<string> }>()
  let model = ctx.clientModel
  let usage: ChatCompletionUsage | undefined
  let finishReason: FinishReason | null = null
  let sequenceNumber = 0
  let textPartStarted = false
  let messageItemEmitted = false
  let started = false

  // Emit `response.created` once, lazily — before any chunk updates `model`, so
  // it carries the injected clientModel (matching the legacy generator's
  // pre-loop emission).
  const ensureStarted = (out: Array<ResponsesStreamFrame>): void => {
    if (started) return
    started = true
    out.push(
      responsesStreamEvent("response.created", {
        type: "response.created",
        sequence_number: sequenceNumber++,
        response: createSyntheticResponsesResponse({ id: ctx.responseId, createdAt, status: "in_progress", model, output: [], usage }),
      }),
    )
  }

  return {
    translate(ccData) {
      const out: Array<ResponsesStreamFrame> = []
      ensureStarted(out)

      const parsed = parseChatCompletionStreamData(ccData)
      if (!parsed) return out

      if (typeof parsed.model === "string" && parsed.model.length > 0) model = parsed.model
      if (parsed.usage) usage = parsed.usage as ChatCompletionUsage

      const choices = parsed.choices as Array<Record<string, unknown>> | undefined
      const choice = choices?.[0]
      const delta = choice?.delta as Record<string, unknown> | undefined
      if (typeof choice?.finish_reason === "string") {
        finishReason = choice.finish_reason as FinishReason
      }

      // Text delta
      if (typeof delta?.content === "string" && delta.content.length > 0) {
        if (!messageItemEmitted) {
          out.push(
            responsesStreamEvent("response.output_item.added", {
              type: "response.output_item.added",
              sequence_number: sequenceNumber++,
              output_index: 0,
              item: { id: ctx.itemId, type: "message", role: "assistant", status: "incomplete", content: [] },
            }),
          )
          messageItemEmitted = true
        }
        if (!textPartStarted) {
          out.push(
            responsesStreamEvent("response.content_part.added", {
              type: "response.content_part.added",
              sequence_number: sequenceNumber++,
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            }),
          )
          textPartStarted = true
        }

        contentParts.push(delta.content)
        out.push(
          responsesStreamEvent("response.output_text.delta", {
            type: "response.output_text.delta",
            sequence_number: sequenceNumber++,
            output_index: 0,
            content_index: 0,
            delta: delta.content,
          }),
        )
      }

      // Tool call deltas
      if (delta?.tool_calls) {
        const toolCallDeltas = delta.tool_calls as Array<Record<string, unknown>>
        for (const tc of toolCallDeltas) {
          const toolIndex = typeof tc.index === "number" ? tc.index : 0
          const fn = tc.function as Record<string, unknown> | undefined
          const existing = toolCalls.get(toolIndex)

          if (!existing) {
            const callId = typeof tc.id === "string" ? tc.id : `call_${toolIndex}`
            const name = typeof fn?.name === "string" ? fn.name : ""
            toolCalls.set(toolIndex, { id: callId, callId, name, arguments: [] })

            out.push(
              responsesStreamEvent("response.output_item.added", {
                type: "response.output_item.added",
                sequence_number: sequenceNumber++,
                output_index: toolIndex + 1,
                item: {
                  type: "function_call",
                  id: callId,
                  call_id: callId,
                  name,
                  arguments: "",
                  status: "incomplete",
                },
              }),
            )
          } else if (typeof fn?.name === "string" && !existing.name) {
            existing.name = fn.name
          }

          if (typeof fn?.arguments === "string" && fn.arguments.length > 0) {
            const current = toolCalls.get(toolIndex)
            current?.arguments.push(fn.arguments)
            out.push(
              responsesStreamEvent("response.function_call_arguments.delta", {
                type: "response.function_call_arguments.delta",
                sequence_number: sequenceNumber++,
                output_index: toolIndex + 1,
                item_id: current?.id ?? `call_${toolIndex}`,
                delta: fn.arguments,
              }),
            )
          }
        }
      }

      return out
    },

    flush() {
      const out: Array<ResponsesStreamFrame> = []
      ensureStarted(out)

      const text = contentParts.join("")
      const output: Array<ResponsesOutputItem> = []

      // Close the message item only if it was opened (i.e. some text arrived).
      if (textPartStarted) {
        out.push(
          responsesStreamEvent("response.output_text.done", {
            type: "response.output_text.done",
            sequence_number: sequenceNumber++,
            output_index: 0,
            content_index: 0,
            text,
          }),
          responsesStreamEvent("response.content_part.done", {
            type: "response.content_part.done",
            sequence_number: sequenceNumber++,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text, annotations: [] },
          }),
        )

        const messageOutput: ResponsesOutputItem = {
          id: ctx.itemId,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        }
        output.push(messageOutput)

        out.push(
          responsesStreamEvent("response.output_item.done", {
            type: "response.output_item.done",
            sequence_number: sequenceNumber++,
            output_index: 0,
            item: messageOutput,
          }),
        )
      }

      for (const [toolIndex, toolCall] of toolCalls) {
        const args = toolCall.arguments.join("")
        const item: ResponsesOutputItem = {
          type: "function_call",
          id: toolCall.id,
          call_id: toolCall.callId,
          name: toolCall.name,
          arguments: args,
          status: "completed",
        }

        out.push(
          responsesStreamEvent("response.function_call_arguments.done", {
            type: "response.function_call_arguments.done",
            sequence_number: sequenceNumber++,
            output_index: toolIndex + 1,
            item_id: toolCall.id,
            arguments: args,
          }),
          responsesStreamEvent("response.output_item.done", {
            type: "response.output_item.done",
            sequence_number: sequenceNumber++,
            output_index: toolIndex + 1,
            item,
          }),
        )

        output.push(item)
      }

      const { status, incompleteReason } = ccFinishReasonToResponsesStatus(finishReason)
      out.push(
        responsesStreamEvent("response.completed", {
          type: "response.completed",
          sequence_number: sequenceNumber,
          response: createSyntheticResponsesResponse({ id: ctx.responseId, createdAt, status, model, output, usage, incompleteReason }),
        }),
      )

      return out
    },
  }
}

/**
 * Translate an upstream CC SSE stream into Responses-shaped SSE events.
 *
 * Emits the Responses lifecycle event sequence:
 *   response.created → response.output_item.added (message, only if text arrives)
 *     → response.content_part.added → response.output_text.delta (×N) → response.output_text.done
 *     → response.content_part.done → response.output_item.done (message)
 *   → response.output_item.added (function_call, per tool call)
 *     → response.function_call_arguments.delta (×N) → response.function_call_arguments.done
 *     → response.output_item.done (function_call)
 *   → response.completed
 *
 * Tool-only responses skip the message-item lifecycle entirely (no synthetic
 * empty message). Thin whole-stream driver over
 * {@link createCCToResponsesStreamTranslator} so the v4 codec (per-frame) and
 * this legacy path stay byte-identical.
 */
export async function* translateCCStreamToResponsesStream(
  ccStream: AsyncIterable<ServerSentEventMessage>,
  ctx: TranslateExchangeContext,
): AsyncGenerator<ResponsesStreamFrame, void, unknown> {
  const translator = createCCToResponsesStreamTranslator(ctx)
  for await (const chunk of ccStream) {
    yield* translator.translate(chunk.data ?? "")
  }
  yield* translator.flush()
}

// ============================================================================
// File-scoped helpers
// ============================================================================

/** Map CC finish_reason to Responses status + incomplete reason. */
function ccFinishReasonToResponsesStatus(reason: FinishReason | null): {
  status: ResponsesResponse["status"]
  incompleteReason?: string
} {
  switch (reason) {
    case "length": {
      return { status: "incomplete", incompleteReason: "max_output_tokens" }
    }
    case "content_filter": {
      return { status: "incomplete", incompleteReason: "content_filter" }
    }
    case "tool_calls":
    case "function_call":
    case "stop":
    case null: {
      return { status: "completed" }
    }
    default: {
      return { status: "completed" }
    }
  }
}

function ccUsageToResponsesUsage(usage: ChatCompletionUsage): ResponsesResponse["usage"] {
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    // Preserve the cached-read subset so downstream net-of-cache normalization
    // (usage-normalize.ts) can recover the disjoint input/cache split — otherwise
    // the via-responses fallback silently drops cache_read (richest-data-flow).
    ...(usage.prompt_tokens_details?.cached_tokens !== undefined && {
      input_tokens_details: { cached_tokens: usage.prompt_tokens_details.cached_tokens },
    }),
  }
}

function responsesStreamEvent(event: string, data: Record<string, unknown>): { event: string; data: string } {
  return { event, data: JSON.stringify(data) }
}

function parseChatCompletionStreamData(data: string): Record<string, unknown> | null {
  if (!data) return null
  try {
    if (data.trim() === "[DONE]") return null
    return JSON.parse(data) as Record<string, unknown>
  } catch {
    return null
  }
}

function createSyntheticResponsesResponse(opts: {
  id: string
  createdAt: number
  status: ResponsesResponse["status"]
  model: string
  output: Array<ResponsesOutputItem>
  usage?: ChatCompletionUsage
  incompleteReason?: string
}): ResponsesResponse {
  return {
    id: opts.id,
    object: "response",
    created_at: opts.createdAt,
    status: opts.status,
    model: opts.model,
    output: opts.output,
    usage: opts.usage ? ccUsageToResponsesUsage(opts.usage) : null,
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
    ...(opts.incompleteReason && { incomplete_details: { reason: opts.incompleteReason } }),
  }
}

function translateInputItemToMessages(item: ResponsesInputItem): Array<Message> {
  if (item.type === "function_call") {
    return [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id ?? item.id ?? "",
            type: "function",
            function: {
              name: item.name ?? "",
              arguments: item.arguments ?? "",
            },
          },
        ],
      },
    ]
  }

  if (item.type === "function_call_output") {
    return [
      {
        role: "tool",
        tool_call_id: item.call_id ?? item.id ?? "",
        content: item.output ?? "",
      },
    ]
  }

  // reasoning / item_reference items have no CC equivalent — drop silently.
  if (item.type === "reasoning" || item.type === "item_reference") return []

  const role = item.role ?? "user"
  const content = translateContentParts(item.content, role)

  if (role === "system" || role === "developer") {
    return [{ role: "system", content: typeof content === "string" ? content : "" }]
  }

  return [{ role, content }]
}

function translateContentParts(content: ResponsesInputItem["content"], role: ResponsesInputItem["role"] = "user"): string | Array<ContentPart> | null {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return null

  // Non-user roles (assistant, system, developer) — concatenate text parts only.
  if (role !== "user") {
    return content
      .map((part) => {
        if ("text" in part && typeof part.text === "string") return part.text
        if (part.type === "input_file") return part.filename ?? part.file_id ?? ""
        return ""
      })
      .filter(Boolean)
      .join("")
  }

  const parts: Array<ContentPart> = []
  for (const part of content) {
    if ((part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text })
      continue
    }
    if (part.type === "input_image" && typeof part.image_url === "string") {
      parts.push({
        type: "image_url",
        image_url: {
          url: part.image_url,
          ...(part.detail && { detail: part.detail }),
        },
      })
      continue
    }
    // input_file has no clean CC equivalent — drop.
  }

  return parts.length > 0 ? parts : ""
}

/**
 * Schema handed to the model for a degraded freeform/custom tool: a single
 * required string field carrying the freeform text the custom tool would have
 * taken directly. The model has no native freeform slot on `/chat/completions`,
 * so this gives it one. (Response-side: the resulting function_call args land as
 * `{"input":"…"}` JSON rather than a raw `custom_tool_call` — a known fallback
 * limitation, see module note below.)
 */
const FREEFORM_TOOL_PARAMETERS = {
  type: "object",
  properties: { input: { type: "string", description: "Freeform text input for this tool." } },
  required: ["input"],
} as const

/**
 * Translate Responses tools → Chat Completions tools.
 *
 * Copilot's `/chat/completions` upstream only accepts **function** tools, so the
 * fallback must reshape the others rather than forward them:
 *   - `function` → passthrough (1:1).
 *   - `custom` (freeform, e.g. Codex `apply_patch`) → degrade to a function tool
 *     with a single freeform string param. Preserves tool availability through
 *     the fallback (the model can still call it) at the cost of the freeform
 *     grammar; warned so the degradation is observable.
 *   - builtin server tools (`web_search`/`file_search`/`code_interpreter`) →
 *     dropped (unsupported on CC), warned so the loss is not silent.
 *
 * The earlier implementation silently `.filter`ed to function-only, dropping
 * custom + builtin tools with no trace. (The direct `/responses` passthrough is
 * unaffected — it never calls this.)
 */
function translateToolsToCC(tools: Array<ResponsesTool>): Array<Tool> {
  const out: Array<Tool> = []
  for (const tool of tools) {
    if (tool.type === "function") {
      out.push({
        type: "function",
        function: {
          name: tool.name,
          ...(tool.description !== undefined && { description: tool.description }),
          ...(tool.parameters !== undefined && { parameters: tool.parameters }),
          ...(tool.strict !== undefined && { strict: tool.strict }),
        },
      })
    } else if (tool.type === "custom") {
      consola.warn(
        `[Responses→CC] custom tool "${tool.name}" degraded to a function tool (freeform input → string parameter) for the /chat/completions fallback`,
      )
      out.push({
        type: "function",
        function: {
          name: tool.name,
          ...(tool.description !== undefined && { description: tool.description }),
          parameters: { ...FREEFORM_TOOL_PARAMETERS },
        },
      })
    } else {
      const id = typeof tool.type === "string" ? tool.type : "unknown"
      consola.warn(`[Responses→CC] dropping builtin tool "${id}" unsupported by the /chat/completions fallback`)
    }
  }
  return out
}

function translateToolChoiceToCC(choice: ResponsesToolChoice): NonNullable<ChatCompletionsPayload["tool_choice"]> {
  if (typeof choice === "string") return choice
  return {
    type: "function",
    function: { name: choice.name },
  }
}

function translateResponseFormatToCC(format: ResponsesTextFormat): ResponseFormat {
  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: format.name,
        ...(format.description !== undefined && { description: format.description }),
        schema: format.schema,
        ...(format.strict !== undefined && { strict: format.strict }),
      },
    }
  }
  return { type: format.type }
}
