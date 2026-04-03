import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"

import consola from "consola"
import { SSEStreamingApi, streamSSE } from "hono/streaming"

import type { RequestContext } from "~/lib/context/request"
import type { HeadersCapture } from "~/lib/context/request"
import type { MessageContent } from "~/lib/history"
import type { Model } from "~/lib/models/client"
import type { FormatAdapter } from "~/lib/request/pipeline"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/types/api/openai-chat-completions"
import type { ResponsesResponse } from "~/types/api/openai-responses"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import { MAX_AUTO_TRUNCATE_RETRIES } from "~/lib/auto-truncate"
import { getRequestContextManager } from "~/lib/context/manager"
import { HTTPError } from "~/lib/error"
import { ENDPOINT, isEndpointSupported, isResponsesSupported } from "~/lib/models/endpoint"
import { resolveModelName } from "~/lib/models/resolver"
import {
  autoTruncateOpenAI,
  createTruncationResponseMarkerOpenAI,
  type OpenAIAutoTruncateResult,
} from "~/lib/openai/auto-truncate"
import { createChatCompletions } from "~/lib/openai/chat-completions-client"
import { createResponses } from "~/lib/openai/responses-client"
import { sanitizeOpenAIMessages } from "~/lib/openai/sanitize"
import { createOpenAIStreamAccumulator, accumulateOpenAIStreamEvent } from "~/lib/openai/stream-accumulator"
import {
  createStreamTranslator,
  translateChatCompletionsToResponses,
  translateResponsesResponseToCC,
  translateResponsesStream,
} from "~/lib/openai/translate"
import { buildOpenAIResponseData, isNonStreaming, logPayloadSizeInfo } from "~/lib/request"
import { executeRequestPipeline, type RetryStrategy } from "~/lib/request/pipeline"
import { createAutoTruncateStrategy, type TruncateResult } from "~/lib/request/strategies/auto-truncate"
import { createNetworkRetryStrategy } from "~/lib/request/strategies/network-retry"
import { createTokenRefreshStrategy } from "~/lib/request/strategies/token-refresh"
import { getShutdownSignal } from "~/lib/shutdown"
import { state } from "~/lib/state"
import { STREAM_ABORTED, StreamIdleTimeoutError, combineAbortSignals, raceIteratorNext } from "~/lib/stream"
import { processOpenAIMessages } from "~/lib/system-prompt"
import { tuiLogger } from "~/lib/tui"
import { isNullish } from "~/lib/utils"
import { extractInputItems, normalizeCallIds } from "~/routes/responses/pipeline"

const DROPPED_CC_PARAMS_WARNING_CODE = "cc_to_responses_dropped_params"

export async function handleChatCompletion(c: Context) {
  const originalPayload = await c.req.json<ChatCompletionsPayload>()

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
  const reqCtx = manager.create({ endpoint: "openai-chat-completions", tuiLogId })
  reqCtx.setOriginalRequest({
    // Use client's original model name (before resolution/overrides)
    model: clientModel,
    messages: originalPayload.messages as unknown as Array<MessageContent>,
    stream: originalPayload.stream ?? false,
    tools: originalPayload.tools?.map((t) => ({
      name: t.function.name,
      description: t.function.description,
    })),
    payload: originalPayload,
  })

  // Update TUI tracker with model info (immediate feedback)
  if (tuiLogId) {
    tuiLogger.updateRequest(tuiLogId, {
      model: originalPayload.model,
      ...(clientModel !== originalPayload.model && { clientModel }),
    })
  }

  // Sanitize messages (filter orphaned tool blocks, system-reminders)
  const { payload: sanitizedPayload } = sanitizeOpenAIMessages(originalPayload)

  const finalPayload =
    isNullish(sanitizedPayload.max_tokens) ?
      {
        ...sanitizedPayload,
        max_tokens: selectedModel?.capabilities?.limits?.max_output_tokens,
      }
    : sanitizedPayload

  if (isNullish(originalPayload.max_tokens)) {
    consola.debug("Set max_tokens to:", JSON.stringify(finalPayload.max_tokens))
  }

  if (isEndpointSupported(selectedModel, ENDPOINT.CHAT_COMPLETIONS)) {
    return executeRequest({
      c,
      payload: finalPayload,
      originalPayload,
      selectedModel,
      reqCtx,
    })
  }

  if (isResponsesSupported(selectedModel)) {
    if (tuiLogId) {
      tuiLogger.updateRequest(tuiLogId, { tags: ["via-responses"] })
    }
    return executeRequestViaResponses({
      c,
      payload: finalPayload,
      originalPayload,
      selectedModel,
      reqCtx,
    })
  }

  const msg = `Model "${originalPayload.model}" does not support the ${ENDPOINT.CHAT_COMPLETIONS} endpoint`
  throw new HTTPError(msg, 400, msg)
}

/** Options for executeRequest */
interface ExecuteRequestOptions {
  c: Context
  payload: ChatCompletionsPayload
  originalPayload: ChatCompletionsPayload
  selectedModel: Model | undefined
  reqCtx: RequestContext
}

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
    execute: (p) =>
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
    execute: async (ccPayload) => {
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
    adapter,
    strategies,
    headersCapture,
  })
}

function recordDroppedCcParamsWarning(reqCtx: RequestContext, model: string, droppedParams: Array<string>) {
  const paramsText = droppedParams.join(", ")
  const message = `Chat Completions -> Responses translation dropped unsupported params: ${paramsText}`
  const alreadyRecorded = reqCtx.warningMessages.some(
    (warning) => warning.code === DROPPED_CC_PARAMS_WARNING_CODE && warning.message === message,
  )

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
      truncate: (p, model, truncOpts) =>
        autoTruncateOpenAI(p, model, truncOpts) as Promise<TruncateResult<ChatCompletionsPayload>>,
      resanitize: (p) => sanitizeOpenAIMessages(p),
      isEnabled: () => state.autoTruncate,
      label,
    }),
  ]
}

interface ExecuteRequestWithAdapterOptions extends ExecuteRequestOptions {
  adapter: FormatAdapter<ChatCompletionsPayload>
  strategies: Array<RetryStrategy<ChatCompletionsPayload>>
  headersCapture: HeadersCapture
}

async function executeRequestWithAdapter(opts: ExecuteRequestWithAdapterOptions) {
  const { c, payload, originalPayload, selectedModel, reqCtx, adapter, strategies, headersCapture } = opts

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

    const response = result.response

    if (isNonStreaming(response as ChatCompletionResponse | AsyncIterable<unknown>)) {
      return handleNonStreamingResponse(c, response as ChatCompletionResponse, reqCtx, truncateResult)
    }

    consola.debug("Streaming response")
    reqCtx.transition("streaming")

    return streamSSE(c, async (stream) => {
      const clientAbort = new AbortController()
      stream.onAbort(() => clientAbort.abort())

      await handleStreamingResponse({
        stream,
        response: response as AsyncIterable<ServerSentEventMessage>,
        payload,
        reqCtx,
        truncateResult,
        clientAbortSignal: clientAbort.signal,
      })
    })
  } catch (error) {
    reqCtx.setHttpHeaders(headersCapture)
    reqCtx.fail(payload.model, error)
    throw error
  }
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
      choices: [
        { ...firstChoice, message: { ...firstChoice.message, content: `${marker}${firstChoice.message.content}` } },
        ...response.choices.slice(1),
      ],
    }
  }

  const choice = response.choices[0]
  const usage = response.usage

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

  return c.json(response)
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
      acc.rawContent += marker
    }

    const iterator = response[Symbol.asyncIterator]()

    for (;;) {
      const abortSignal = combineAbortSignals(getShutdownSignal(), clientAbortSignal)
      const result = await raceIteratorNext(iterator.next(), { idleTimeoutMs, abortSignal })

      if (result === STREAM_ABORTED) break
      if (result.done) break

      const rawEvent = result.value

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
        } catch {
          // Ignore parse errors
        }
      }

      // Forward every event to client — proxy preserves upstream data
      await stream.writeSSE({
        data: rawEvent.data ?? "",
        event: rawEvent.event,
        id: rawEvent.id !== undefined ? String(rawEvent.id) : undefined,
        retry: rawEvent.retry,
      })
    }

    const responseData = buildOpenAIResponseData(acc, payload.model)
    reqCtx.complete(responseData)
  } catch (error) {
    consola.error("[ChatCompletions] Stream error:", error)
    reqCtx.fail(acc.model || payload.model, error)

    // Send error to client as final SSE event (consistent with Anthropic path)
    const errorMessage = error instanceof Error ? error.message : String(error)
    await stream.writeSSE({
      data: JSON.stringify({
        error: {
          message: errorMessage,
          type: error instanceof StreamIdleTimeoutError ? "timeout_error" : "server_error",
        },
      }),
      event: "error",
    })
  }
}
