import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"

import consola from "consola"
import {
  //
  SSEStreamingApi,
  streamSSE,
} from "hono/streaming"

import type { RequestContext } from "~/lib/context/request"
import type { HeadersCapture } from "~/lib/context/request"
import type {
  //
  MessageContent,
  SseEventRecord,
} from "~/lib/history"
import type { Model } from "~/lib/models/client"
import type { FormatAdapter } from "~/lib/request/pipeline"
import type { ToolNameMapper } from "~/lib/tool-name-mapper"
import type {
  //
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/types/api/openai-chat-completions"
import type { ResponsesResponse } from "~/types/api/openai-responses"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import { MAX_AUTO_TRUNCATE_RETRIES } from "~/lib/auto-truncate"
import { getRequestContextManager } from "~/lib/context/manager"
import { HTTPError } from "~/lib/error"
import { captureInboundHeaders } from "~/lib/fetch-utils"
import { getSessionIdFromHeaders } from "~/lib/history/store"
import {
  //
  ENDPOINT,
  isEndpointSupported,
  isResponsesSupported,
} from "~/lib/models/endpoint"
import { resolveModelName } from "~/lib/models/resolver"
import {
  //
  autoTruncateOpenAI,
  createTruncationResponseMarkerOpenAI,
  type OpenAIAutoTruncateResult,
} from "~/lib/openai/auto-truncate"
import { createChatCompletions } from "~/lib/openai/chat-completions-client"
import { createResponses } from "~/lib/openai/responses-client"
import {
  //
  extractInputItems,
  normalizeCallIds,
} from "~/lib/openai/responses-conversion"
import { sanitizeOpenAIMessages } from "~/lib/openai/sanitize"
import {
  //
  createOpenAIStreamAccumulator,
  accumulateOpenAIStreamEvent,
} from "~/lib/openai/stream-accumulator"
import { streamErrorToOpenAIErrorType } from "~/lib/openai/stream-error"
import {
  //
  applyChatCompletionsToolNameSanitization,
  buildChatCompletionsToolNameMapper,
  restoreChatCompletionsChunkToolNames,
  restoreChatCompletionsToolNames,
} from "~/lib/openai/tool-name-sanitize"
import {
  //
  createStreamTranslator,
  translateChatCompletionsToResponses,
  translateResponsesResponseToCC,
  translateResponsesStream,
} from "~/lib/openai/translate"
import {
  //
  buildOpenAIResponseData,
  isNonStreaming,
  logPayloadSizeInfo,
} from "~/lib/request"
import {
  //
  executeRequestPipeline,
  type RetryStrategy,
} from "~/lib/request/pipeline"
import {
  //
  createAutoTruncateStrategy,
  type TruncateResult,
} from "~/lib/request/strategies/auto-truncate"
import { createNetworkRetryStrategy } from "~/lib/request/strategies/network-retry"
import { createTokenRefreshStrategy } from "~/lib/request/strategies/token-refresh"
import { getShutdownSignal } from "~/lib/shutdown"
import { state } from "~/lib/state"
import {
  //
  guardSseIterable,
} from "~/lib/stream"
import { processOpenAIMessages } from "~/lib/system-prompt"
import { tuiLogger } from "~/lib/tui"
import { isNullish } from "~/lib/utils"

const DROPPED_CC_PARAMS_WARNING_CODE = "cc_to_responses_dropped_params"

/**
 * Restore tool-call names (upstream → original) in a single Chat Completions
 * SSE `data` frame. Best-effort: returns the input unchanged on `[DONE]`,
 * empty data, unparseable JSON, or when no name changed (so a malformed frame
 * never aborts the forward loop). No-op when `mapper` is null.
 */
function restoreStreamToolNames(data: string | undefined, mapper: ToolNameMapper | null): string {
  if (!mapper || !data || data === "[DONE]") return data ?? ""
  let chunk: unknown
  try {
    chunk = JSON.parse(data)
  } catch {
    return data
  }
  return restoreChatCompletionsChunkToolNames(chunk, mapper) ? JSON.stringify(chunk) : data
}

export async function handleChatCompletion(c: Context) {
  const originalPayload = (c.get("injectedPayload") as ChatCompletionsPayload | undefined) ?? (await c.req.json<ChatCompletionsPayload>())

  // Snapshot the inbound payload BEFORE any mutation so the recorded
  // "original" reflects what the client actually sent — handlers below
  // rewrite model / messages in place. Without this snapshot the history
  // view would show a half-processed payload as the user's raw input.
  const originalSnapshot = structuredClone(originalPayload)

  // Azure deployment routes pass the deployment-name as an explicit override
  // instead of mutating body.model. Apply AFTER snapshotting so history sees
  // the client's raw body and the protocol contract still holds (path wins).
  const azureModelOverride = c.get("azureModelOverride") as string | undefined
  if (azureModelOverride !== undefined) {
    originalPayload.model = azureModelOverride
  }

  // Resolve model name aliases and date-suffixed versions
  const clientModel = originalPayload.model
  const resolvedModel = resolveModelName(clientModel)
  if (resolvedModel !== clientModel) {
    consola.debug(`Model name resolved: ${clientModel} → ${resolvedModel}`)
    originalPayload.model = resolvedModel
  }

  // Find the selected model
  const selectedModel = state.modelIndex.get(originalPayload.model)

  // System prompt collection + config-based overrides (always active)
  originalPayload.messages = await processOpenAIMessages(originalPayload.messages, originalPayload.model)

  // Get tracking ID
  const tuiLogId = c.get("tuiLogId") as string | undefined

  // Create request context — triggers "created" event → history consumer inserts entry
  const manager = getRequestContextManager()
  const reqCtx = manager.create({
    endpoint: "openai-chat-completions",
    sessionId: getSessionIdFromHeaders(c.req.raw.headers),
    tuiLogId,
    rawPath: c.req.path,
  })
  reqCtx.setOriginalRequest({
    // Use client's original model name (before resolution/overrides)
    model: clientModel,
    messages: originalSnapshot.messages as unknown as Array<MessageContent>,
    stream: originalSnapshot.stream ?? false,
    tools: originalSnapshot.tools?.map((t) => ({
      name: t.function.name,
      description: t.function.description,
    })),
    payload: originalSnapshot,
  })
  reqCtx.setInboundRequestHeaders(captureInboundHeaders(c.req.raw.headers))

  // Build the per-request tool-name sanitization mapper from the client's tool
  // definitions, then rename tool names to their upstream form on the working
  // payload. The original snapshot above keeps the client's original names for
  // history; response handlers restore upstream → original via this mapper.
  const toolNameMapper = buildChatCompletionsToolNameMapper(originalPayload, selectedModel?.vendor)
  reqCtx.setToolNameMapper(toolNameMapper)
  const renamedPayload = applyChatCompletionsToolNameSanitization(originalPayload, toolNameMapper)
  originalPayload.messages = renamedPayload.messages
  originalPayload.tools = renamedPayload.tools

  // Update TUI tracker with model info (immediate feedback)
  if (tuiLogId) {
    tuiLogger.updateRequest(tuiLogId, {
      model: originalPayload.model,
      ...(clientModel !== originalPayload.model && { clientModel }),
    })
  }

  // Sanitize messages (filter orphaned tool blocks, system-reminders)
  const { payload: sanitizedPayload } = sanitizeOpenAIMessages(originalPayload)

  // Auto-fill max output tokens if neither max_tokens nor max_completion_tokens is provided
  const hasMaxTokens = !isNullish(sanitizedPayload.max_tokens) || !isNullish(sanitizedPayload.max_completion_tokens)
  const finalPayload =
    hasMaxTokens ? sanitizedPayload : (
      {
        ...sanitizedPayload,
        max_completion_tokens: selectedModel?.capabilities?.limits?.max_output_tokens,
      }
    )

  if (!hasMaxTokens) {
    consola.debug("Set max_completion_tokens to:", JSON.stringify(finalPayload.max_completion_tokens))
  }

  return runChatCompletionPipeline({
    c,
    payload: finalPayload,
    originalPayload,
    selectedModel,
    reqCtx,
    render: defaultChatCompletionRenderer,
  })
}

/**
 * Options for runChatCompletionPipeline — the reusable inner pipeline that
 * other handlers (Gemini, future protocols) can wrap to reuse all of:
 * model-capability routing, retry strategies, sanitize, auto-truncate,
 * history recording, rate limiting, and stream/non-stream dispatch.
 *
 * The caller is responsible for:
 * - Parsing and snapshotting their own request body
 * - Creating the `reqCtx` with the appropriate endpoint type
 * - Calling `setOriginalRequest()` on `reqCtx` BEFORE invoking the pipeline
 * - Providing a `render` callback that serializes the raw upstream response
 *   to the protocol-specific wire format.
 */
export interface RunChatCompletionPipelineOptions {
  c: Context
  payload: ChatCompletionsPayload
  originalPayload: ChatCompletionsPayload
  selectedModel: Model | undefined
  reqCtx: RequestContext
  /** Protocol-specific renderer for the raw upstream result */
  render: ChatCompletionRenderer
}

/**
 * Renderer hook: receives the raw upstream response (already classified as
 * streaming or not) plus the same context bag used by the default renderer.
 * Implementations MUST call `reqCtx.complete()` / `reqCtx.fail()` to settle
 * the request context, and MUST return a `Response`.
 */
export interface ChatCompletionRenderer {
  (args: ChatCompletionRendererArgs): Promise<Response> | Response
}

export interface ChatCompletionRendererArgs {
  c: Context
  /** Raw upstream response — guaranteed shape via `isNonStreaming` guard */
  response: ChatCompletionResponse | AsyncIterable<ServerSentEventMessage>
  payload: ChatCompletionsPayload
  reqCtx: RequestContext
  truncateResult: OpenAIAutoTruncateResult | undefined
}

/**
 * Reusable execution core — dispatches to the appropriate execute path based
 * on model capability (chat-completions vs responses bridge), runs the retry
 * pipeline, and hands the raw upstream result to `render` for serialization.
 *
 * Throws on pipeline failure (caller should wrap with `forwardError`).
 */
export async function runChatCompletionPipeline(opts: RunChatCompletionPipelineOptions): Promise<Response> {
  const { selectedModel, payload, c } = opts

  if (isEndpointSupported(selectedModel, ENDPOINT.CHAT_COMPLETIONS)) {
    return executeRequest(opts)
  }

  if (isResponsesSupported(selectedModel)) {
    if (opts.reqCtx.tuiLogId) {
      tuiLogger.updateRequest(opts.reqCtx.tuiLogId, { tags: ["via-responses"] })
    }
    return executeRequestViaResponses(opts)
  }

  // No-op reference: forces the unused `c` binding to be tree-shake-visible
  // when only this branch runs (kept as one statement to avoid touching
  // unrelated logic in this refactor).
  void c
  const msg = `Model "${payload.model}" does not support the ${ENDPOINT.CHAT_COMPLETIONS} endpoint`
  throw new HTTPError(msg, 400, msg)
}

/** Options for executeRequest */
type ExecuteRequestOptions = RunChatCompletionPipelineOptions

/**
 * Execute the API call with reactive retry pipeline.
 * Handles 413 and token limit errors with auto-truncation.
 */
async function executeRequest(opts: ExecuteRequestOptions) {
  const { c, payload, originalPayload, selectedModel, reqCtx } = opts

  // Build adapter and strategy for the pipeline
  const headersCapture: HeadersCapture = {}
  const adapter: FormatAdapter<ChatCompletionsPayload> = {
    format: "openai-chat-completions",
    sanitize: (p) => sanitizeOpenAIMessages(p),
    // `_hints` is the PrepareHints bag forwarded by the pipeline from the
    // previous retry attempt. The chat-completions request preparation does
    // not yet consume hints; the argument is accepted (and ignored) so any
    // future hints-producing strategy explicitly documents what it expects
    // to land here. See lib/request/pipeline.ts PrepareHints docstring.
    execute: (p, _hints) =>
      executeWithAdaptiveRateLimit(() =>
        createChatCompletions(p, {
          resolvedModel: selectedModel,
          headersCapture,
          onPrepared: ({ wire, headers }) => {
            reqCtx.setAttemptWireRequest({
              model: typeof wire.model === "string" ? wire.model : payload.model,
              messages: Array.isArray(wire.messages) ? wire.messages : [],
              payload: wire,
              headers,
              format: "openai-chat-completions",
            })
          },
        }),
      ),
    logPayloadSize: (p) => logPayloadSizeInfo(p, selectedModel),
  }

  const strategies = createChatCompletionsStrategies("Completions")

  return executeRequestWithAdapter({
    c,
    payload,
    originalPayload,
    selectedModel,
    reqCtx,
    render: opts.render,
    adapter,
    strategies,
    headersCapture,
  })
}

async function executeRequestViaResponses(opts: ExecuteRequestOptions) {
  const { c, payload, originalPayload, selectedModel, reqCtx } = opts
  const headersCapture: HeadersCapture = {}
  const adapter: FormatAdapter<ChatCompletionsPayload> = {
    format: "openai-chat-completions",
    sanitize: (p) => sanitizeOpenAIMessages(p),
    execute: async (ccPayload, _hints) => {
      // `_hints`: see PrepareHints in lib/request/pipeline.ts. The cc-as-
      // responses bridge does not yet consume hints; future strategies that
      // produce hints for this path must update both this adapter and the
      // downstream responses preparation.
      const { payload: responsesPayload, droppedParams } = translateChatCompletionsToResponses(ccPayload)
      if (droppedParams.length > 0) {
        recordDroppedCcParamsWarning(reqCtx, ccPayload.model, droppedParams)
      }

      const finalPayload = state.normalizeResponsesCallIds ? normalizeCallIds(responsesPayload) : responsesPayload
      const result = await executeWithAdaptiveRateLimit(() =>
        createResponses(finalPayload, {
          resolvedModel: selectedModel,
          headersCapture,
          onPrepared: ({ wire, headers }) => {
            reqCtx.setAttemptWireRequest({
              model: typeof wire.model === "string" ? wire.model : ccPayload.model,
              messages: extractInputItems(wire.input),
              payload: wire,
              headers,
              format: "openai-responses",
            })
          },
        }),
      )

      if (!ccPayload.stream) {
        return {
          result: translateResponsesResponseToCC(result.result as ResponsesResponse),
          queueWaitMs: result.queueWaitMs,
        }
      }

      const translatedStream = translateResponsesStream(
        result.result as AsyncIterable<ServerSentEventMessage>,
        createStreamTranslator({ includeUsage: ccPayload.stream_options?.include_usage ?? false }),
      )

      return {
        result: translatedStream,
        queueWaitMs: result.queueWaitMs,
      }
    },
    logPayloadSize: (p) => logPayloadSizeInfo(p, selectedModel),
  }

  const strategies = createChatCompletionsStrategies("Completions(→Responses)")

  return executeRequestWithAdapter({
    c,
    payload,
    originalPayload,
    selectedModel,
    reqCtx,
    render: opts.render,
    adapter,
    strategies,
    headersCapture,
  })
}

function recordDroppedCcParamsWarning(reqCtx: RequestContext, model: string, droppedParams: Array<string>) {
  const paramsText = droppedParams.join(", ")
  const message = `Chat Completions -> Responses translation dropped unsupported params: ${paramsText}`
  const alreadyRecorded = reqCtx.warningMessages.some((warning) => warning.code === DROPPED_CC_PARAMS_WARNING_CODE && warning.message === message)

  if (alreadyRecorded) return

  consola.warn(`[CC→Responses] model=${model} ${message}`)
  reqCtx.addWarningMessage({
    code: DROPPED_CC_PARAMS_WARNING_CODE,
    message,
  })

  if (reqCtx.tuiLogId) {
    tuiLogger.updateRequest(reqCtx.tuiLogId, { tags: ["dropped-params"] })
  }
}

function createChatCompletionsStrategies(label: string): Array<RetryStrategy<ChatCompletionsPayload>> {
  return [
    createNetworkRetryStrategy<ChatCompletionsPayload>(),
    createTokenRefreshStrategy<ChatCompletionsPayload>(),
    createAutoTruncateStrategy<ChatCompletionsPayload>({
      truncate: (p, model, truncOpts) => autoTruncateOpenAI(p, model, truncOpts) as Promise<TruncateResult<ChatCompletionsPayload>>,
      resanitize: (p) => sanitizeOpenAIMessages(p),
      isEnabled: () => state.autoTruncate,
      label,
    }),
  ]
}

type ExecuteRequestWithAdapterOptions = ExecuteRequestOptions & {
  adapter: FormatAdapter<ChatCompletionsPayload>
  strategies: Array<RetryStrategy<ChatCompletionsPayload>>
  headersCapture: HeadersCapture
}

async function executeRequestWithAdapter(opts: ExecuteRequestWithAdapterOptions) {
  const { c, payload, originalPayload, selectedModel, reqCtx, adapter, strategies, headersCapture, render } = opts

  // Track truncation result for non-streaming response marker
  let truncateResult: OpenAIAutoTruncateResult | undefined

  try {
    const result = await executeRequestPipeline({
      adapter,
      strategies,
      payload,
      originalPayload,
      model: selectedModel,
      maxRetries: MAX_AUTO_TRUNCATE_RETRIES,
      requestContext: reqCtx,
      onRetry: (attempt, _strategyName, _newPayload, meta) => {
        // Capture truncation result for response marker
        const retryTruncateResult = meta?.truncateResult as OpenAIAutoTruncateResult | undefined
        if (retryTruncateResult) {
          truncateResult = retryTruncateResult
        }

        // Update tracking tags
        if (reqCtx.tuiLogId) {
          tuiLogger.updateRequest(reqCtx.tuiLogId, { tags: ["truncated", `retry-${attempt + 1}`] })
        }
      },
    })

    // Capture HTTP headers from the final attempt for history recording
    reqCtx.setHttpHeaders(headersCapture)

    const response = result.response as ChatCompletionResponse | AsyncIterable<ServerSentEventMessage>
    return await Promise.resolve(render({ c, response, payload, reqCtx, truncateResult }))
  } catch (error) {
    reqCtx.setHttpHeaders(headersCapture)
    reqCtx.fail(payload.model, error)
    throw error
  }
}

/**
 * Default renderer: serves the response in OpenAI Chat Completions wire
 * format — non-streaming as JSON, streaming as SSE with raw upstream events
 * forwarded one-to-one.
 */
function defaultChatCompletionRenderer(args: ChatCompletionRendererArgs): Response | Promise<Response> {
  const { c, response, payload, reqCtx, truncateResult } = args
  if (isNonStreaming(response)) {
    return handleNonStreamingResponse(c, response, reqCtx, truncateResult)
  }

  consola.debug("Streaming response")
  reqCtx.transition("streaming")

  return streamSSE(c, async (stream) => {
    const clientAbort = new AbortController()
    stream.onAbort(() => clientAbort.abort())

    await handleStreamingResponse({
      stream,
      response,
      payload,
      reqCtx,
      truncateResult,
      clientAbortSignal: clientAbort.signal,
    })
  })
}

// Handle non-streaming response
function handleNonStreamingResponse(
  c: Context,
  originalResponse: ChatCompletionResponse,
  reqCtx: RequestContext,
  truncateResult: OpenAIAutoTruncateResult | undefined,
) {
  // Prepend truncation marker if auto-truncate was performed (only in verbose mode)
  let response = originalResponse
  if (state.verbose && truncateResult?.wasTruncated && response.choices[0]?.message.content) {
    const marker = createTruncationResponseMarkerOpenAI(truncateResult)
    const firstChoice = response.choices[0]
    response = {
      ...response,
      choices: [{ ...firstChoice, message: { ...firstChoice.message, content: `${marker}${firstChoice.message.content}` } }, ...response.choices.slice(1)],
    }
  }

  const choice = response.choices[0]
  const usage = response.usage

  // Restore tool_call names (upstream → original) on the client-facing response.
  // Computed before complete() so the forwarded (client-facing) message can be
  // recorded; complete() records the upstream-original message for history.
  const clientResponse = restoreChatCompletionsToolNames(response, reqCtx.toolNameMapper)

  reqCtx.setForwardedResponse({ content: clientResponse.choices[0]?.message })
  reqCtx.complete({
    success: true,
    model: response.model,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
      ...(usage?.prompt_tokens_details?.cached_tokens !== undefined && {
        cache_read_input_tokens: usage.prompt_tokens_details.cached_tokens,
      }),
    },
    stop_reason: choice.finish_reason ?? undefined,
    content: choice.message,
  })

  return c.json(clientResponse)
}

/** Options for handleStreamingResponse */
interface StreamingOptions {
  stream: SSEStreamingApi
  response: AsyncIterable<ServerSentEventMessage>
  payload: ChatCompletionsPayload
  reqCtx: RequestContext
  truncateResult: OpenAIAutoTruncateResult | undefined
  /** Abort signal that fires when the downstream client disconnects */
  clientAbortSignal?: AbortSignal
}

// Handle streaming response
async function handleStreamingResponse(opts: StreamingOptions) {
  const { stream, response, payload, reqCtx, truncateResult, clientAbortSignal } = opts
  const acc = createOpenAIStreamAccumulator()
  const idleTimeoutMs = state.streamIdleTimeout * 1000

  // Forwarded SSE frames — what the client actually received (tool-name restored).
  const forwardedSseEvents: Array<SseEventRecord> = []
  const streamStartMs = Date.now()

  // Streaming metrics for TUI footer
  let bytesIn = 0
  let eventsIn = 0

  try {
    // Prepend truncation marker as first chunk if auto-truncate was performed (only in verbose mode)
    if (state.verbose && truncateResult?.wasTruncated) {
      const marker = createTruncationResponseMarkerOpenAI(truncateResult)
      const markerChunk: ChatCompletionChunk = {
        id: `truncation-marker-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: payload.model,
        choices: [
          {
            index: 0,
            delta: { content: marker },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }
      await stream.writeSSE({
        data: JSON.stringify(markerChunk),
        event: "message",
      })
      forwardedSseEvents.push({ offsetMs: Date.now() - streamStartMs, type: "message", raw: JSON.stringify(markerChunk) })
      acc.rawContent += marker
    }

    const guarded = guardSseIterable(response, {
      idleTimeoutMs,
      shutdownSignal: getShutdownSignal(),
      clientSignal: clientAbortSignal,
    })

    for await (const rawEvent of guarded) {
      bytesIn += rawEvent.data?.length ?? 0
      eventsIn++

      // Update TUI footer with streaming progress
      if (reqCtx.tuiLogId) {
        tuiLogger.updateRequest(reqCtx.tuiLogId, {
          streamBytesIn: bytesIn,
          streamEventsIn: eventsIn,
        })
      }

      // Parse and accumulate for history/tracking (skip [DONE] and empty data)
      if (rawEvent.data && rawEvent.data !== "[DONE]") {
        try {
          const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
          accumulateOpenAIStreamEvent(chunk, acc)
        } catch (err) {
          // Unparseable frame: forwarding is unaffected (raw frame still passes
          // through), but it's dropped from history/token accounting. Log at
          // debug for parity with the Responses/Gemini SSE paths.
          consola.debug(
            `[ChatCompletions] skipping unparseable SSE frame for accumulation (${err instanceof Error ? err.message : String(err)}):`,
            rawEvent.data.slice(0, 200),
          )
        }
      }

      // Forward every event to client — proxy preserves upstream data, except
      // tool-call names are restored (upstream → original) when sanitization is
      // active. History keeps the upstream names (accumulated above).
      const forwardData = restoreStreamToolNames(rawEvent.data, reqCtx.toolNameMapper)
      forwardedSseEvents.push({ offsetMs: Date.now() - streamStartMs, type: rawEvent.event ?? "message", raw: forwardData })
      await stream.writeSSE({
        data: forwardData,
        event: rawEvent.event,
        id: rawEvent.id !== undefined ? String(rawEvent.id) : undefined,
        retry: rawEvent.retry,
      })
    }

    const responseData = buildOpenAIResponseData(acc, payload.model)
    reqCtx.setForwardedResponse({ sseEvents: forwardedSseEvents })
    reqCtx.complete(responseData)
  } catch (error) {
    consola.error("[ChatCompletions] Stream error:", error)
    reqCtx.setForwardedResponse({ sseEvents: forwardedSseEvents })
    reqCtx.fail(acc.model || payload.model, error)

    // Send error to client as final SSE event (consistent with Anthropic path)
    const errorMessage = error instanceof Error ? error.message : String(error)
    await stream.writeSSE({
      data: JSON.stringify({
        error: {
          message: errorMessage,
          type: streamErrorToOpenAIErrorType(error),
        },
      }),
      event: "error",
    })
  }
}
