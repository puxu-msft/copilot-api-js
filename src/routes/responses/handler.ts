/**
 * Handler for inbound OpenAI Responses API requests.
 * Routes directly to Copilot /responses endpoint, or falls back to
 * /chat/completions translation for classic chat-only models.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { HeadersCapture, RequestContext } from "~/lib/context/request"
import type { Model } from "~/lib/models/client"
import type { ChatCompletionResponse } from "~/types/api/openai-chat-completions"
import type { ResponsesPayload, ResponsesResponse, ResponsesStreamEvent } from "~/types/api/openai-responses"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import { getRequestContextManager } from "~/lib/context/manager"
import { HTTPError } from "~/lib/error"
import { getSessionIdFromHeaders, registerResponseSession, resolveResponseSessionId } from "~/lib/history/store"
import { ENDPOINT, isEndpointSupported, isResponsesSupported } from "~/lib/models/endpoint"
import { resolveModelName } from "~/lib/models/resolver"
import { createChatCompletions } from "~/lib/openai/chat-completions-client"
import { responsesInputToMessages, responsesOutputToContent } from "~/lib/openai/responses-conversion"
import {
  accumulateResponsesStreamEvent,
  createResponsesStreamAccumulator,
} from "~/lib/openai/responses-stream-accumulator"
import {
  translateResponsesToChatCompletions,
  translateCCToResponsesResponse,
  translateCCStreamToResponsesStream,
} from "~/lib/openai/translate"
import { executeRequestPipeline } from "~/lib/request/pipeline"
import { buildResponsesResponseData } from "~/lib/request/recording"
import { getShutdownSignal } from "~/lib/shutdown"
import { state } from "~/lib/state"
import { STREAM_ABORTED, StreamIdleTimeoutError, combineAbortSignals, raceIteratorNext } from "~/lib/stream"
import { processResponsesInstructions } from "~/lib/system-prompt"
import { tuiLogger } from "~/lib/tui"

import { createResponsesAdapter, createResponsesStrategies, normalizeCallIds } from "./pipeline"

/** Handle an inbound Responses API request */
export async function handleResponses(c: Context) {
  let payload = await c.req.json<ResponsesPayload>()

  // Resolve model name aliases
  const clientModel = payload.model
  const resolvedModel = resolveModelName(clientModel)
  if (resolvedModel !== clientModel) {
    consola.debug(`Model name resolved: ${clientModel} → ${resolvedModel}`)
    payload.model = resolvedModel
  }

  // Find the selected model metadata block
  const selectedModel = state.modelIndex.get(payload.model)

  // Process system prompt (overrides, prepend, append from config)
  payload.instructions = await processResponsesInstructions(payload.instructions, payload.model)

  // Normalize call IDs before pipeline (call_ → fc_)
  if (state.normalizeResponsesCallIds) {
    payload = normalizeCallIds(payload)
  }
  // Get tracking ID
  const tuiLogId = c.get("tuiLogId") as string | undefined

  // Create request context (Responses API is a distinct OpenAI-format endpoint)
  const manager = getRequestContextManager()
  const reqCtx = manager.create({
    endpoint: "openai-responses",
    sessionId: getSessionIdFromHeaders(c.req.raw.headers) ?? resolveResponseSessionId(payload.previous_response_id),
    tuiLogId,
    rawPath: c.req.path,
  })

  // Record original request for history
  reqCtx.setOriginalRequest({
    model: clientModel,
    messages: responsesInputToMessages(payload.input),
    stream: payload.stream ?? false,
    tools: payload.tools,
    system: payload.instructions ?? undefined,
    payload,
  })

  // Update TUI tracker with model info
  if (tuiLogId) {
    tuiLogger.updateRequest(tuiLogId, {
      model: payload.model,
      ...(clientModel !== payload.model && { clientModel }),
    })
  }

  // Determine if we should intercept and use the Chat Completions fallback pipeline
  const isGoogle = selectedModel?.vendor === "Google"
  const useFallbackPipeline = !isResponsesSupported(selectedModel) || isGoogle

  if (useFallbackPipeline) {
    if (isEndpointSupported(selectedModel, ENDPOINT.CHAT_COMPLETIONS) || isGoogle) {
      if (tuiLogId) {
        tuiLogger.updateRequest(tuiLogId, { tags: ["via-chat-completions-fallback"] })
      }
      return executeResponsesViaChatCompletions({ c, payload, reqCtx, selectedModel })
    }

    const msg = `Model "${payload.model}" does not support the /responses endpoint`
    throw new HTTPError(msg, 400, msg)
  }

  return handleDirectResponses({ c, payload, reqCtx })
}

/** Fallback execution pipeline routing Responses API requests via standard Chat Completions downstream */
async function executeResponsesViaChatCompletions(opts: {
  c: Context
  payload: ResponsesPayload
  reqCtx: RequestContext
  selectedModel: Model | undefined
}) {
  const { c, payload, reqCtx, selectedModel } = opts
  const headersCapture: HeadersCapture = {}

  // 1. Transform inbound payload structure forward
  const ccPayload = translateResponsesToChatCompletions(payload)

  // 2. Encapsulate execution inside custom adapter contract for the request pipeline
  const adapter = {
    format: "openai-responses" as const,
    sanitize: (p: ResponsesPayload) => ({ payload: p, blocksRemoved: 0, systemReminderRemovals: 0 }),
    logPayloadSize: (p: ResponsesPayload) => {
      const count = typeof p.input === "string" ? 1 : p.input.length
      consola.debug(`Responses fallback payload: ${count} input item(s), model: ${p.model}`)
    },
    execute: async (_currentPayload: ResponsesPayload) => {
      const result = await executeWithAdaptiveRateLimit(() =>
        createChatCompletions(ccPayload, {
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
      )

      // Unpack response matrix for standard vs stream variants
      if (!payload.stream) {
        return {
          result: translateCCToResponsesResponse(result.result as ChatCompletionResponse),
          queueWaitMs: result.queueWaitMs,
        }
      }

      const translatedStream = translateCCStreamToResponsesStream(
        result.result as AsyncIterable<ServerSentEventMessage>,
      )

      return {
        result: translatedStream,
        queueWaitMs: result.queueWaitMs,
      }
    },
  }

  const strategies = createResponsesStrategies()

  try {
    const pipelineResult = await executeRequestPipeline({
      adapter,
      strategies,
      payload,
      originalPayload: payload,
      model: selectedModel,
      maxRetries: 1,
      requestContext: reqCtx,
    })

    reqCtx.setHttpHeaders(headersCapture)
    const response = pipelineResult.response

    // Handle Static Non-Streaming fallback response execution complete
    if (!payload.stream) {
      const responsesResponse = response as ResponsesResponse
      if (!reqCtx.sessionId && responsesResponse.id) {
        reqCtx.setSessionId(responsesResponse.id)
      }
      registerResponseSession(responsesResponse.id, reqCtx.sessionId)

      reqCtx.complete({
        success: true,
        model: responsesResponse.model,
        usage: {
          input_tokens: responsesResponse.usage?.input_tokens ?? 0,
          output_tokens: responsesResponse.usage?.output_tokens ?? 0,
        },
        stop_reason: responsesResponse.status,
        content: responsesOutputToContent(responsesResponse.output),
      })
      return c.json(responsesResponse)
    }

    // Handle Streaming fallback response event propagation
    consola.debug("Streaming response (Fallback Responses → Chat Completions)")
    reqCtx.transition("streaming")

    return streamSSE(c, async (stream) => {
      const clientAbort = new AbortController()
      stream.onAbort(() => clientAbort.abort())

      const idleTimeoutMs = state.streamIdleTimeout * 1000
      const acc = createResponsesStreamAccumulator()
      try {
        const iterator = (response as AsyncIterable<{ event: string; data: string }>)[Symbol.asyncIterator]()
        for (;;) {
          const abortSignal = combineAbortSignals(getShutdownSignal(), clientAbort.signal)
          const result = await raceIteratorNext(iterator.next(), { idleTimeoutMs, abortSignal })

          if (result === STREAM_ABORTED || result.done) break
          const item = result.value
          if (item.data && item.data !== "[DONE]") {
            try {
              accumulateResponsesStreamEvent(JSON.parse(item.data) as ResponsesStreamEvent, acc)
            } catch {
              // Ignore parse errors; the client still receives the original event.
            }
          }
          await stream.writeSSE({ event: item.event, data: item.data })
        }
        const responseData = buildResponsesResponseData(acc, payload.model)
        reqCtx.complete(responseData)
      } catch (error) {
        reqCtx.fail(payload.model, error)

        const errorMessage = error instanceof Error ? error.message : String(error)
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            error: {
              message: errorMessage,
              type: error instanceof StreamIdleTimeoutError ? "timeout_error" : "server_error",
            },
          }),
        })
      }
    })
  } catch (error) {
    reqCtx.setHttpHeaders(headersCapture)
    reqCtx.fail(payload.model, error)
    throw error
  }
}

// ============================================================================
// Direct passthrough to /responses endpoint
// ============================================================================

interface ResponsesHandlerOptions {
  c: Context
  payload: ResponsesPayload
  reqCtx: RequestContext
}

/** Pass through to Copilot /responses endpoint directly */
async function handleDirectResponses(opts: ResponsesHandlerOptions) {
  const { c, payload, reqCtx } = opts

  const selectedModel = state.modelIndex.get(payload.model)
  const headersCapture: HeadersCapture = {}
  const adapter = createResponsesAdapter(
    selectedModel,
    headersCapture,
    (wireRequest) => {
      reqCtx.setAttemptWireRequest(wireRequest)
    },
    (transport) => {
      reqCtx.setAttemptTransport(transport)
    },
  )
  const strategies = createResponsesStrategies()

  try {
    const pipelineResult = await executeRequestPipeline({
      adapter,
      strategies,
      payload,
      originalPayload: payload,
      model: selectedModel,
      maxRetries: 1,
      requestContext: reqCtx,
    })

    reqCtx.setHttpHeaders(headersCapture)
    const response = pipelineResult.response

    if (!payload.stream) {
      const responsesResponse = response as ResponsesResponse
      if (!reqCtx.sessionId && responsesResponse.id) {
        reqCtx.setSessionId(responsesResponse.id)
      }
      registerResponseSession(responsesResponse.id, reqCtx.sessionId)
      const content = responsesOutputToContent(responsesResponse.output)

      reqCtx.complete({
        success: true,
        model: responsesResponse.model,
        usage: {
          input_tokens: responsesResponse.usage?.input_tokens ?? 0,
          output_tokens: responsesResponse.usage?.output_tokens ?? 0,
          ...(responsesResponse.usage?.input_tokens_details?.cached_tokens && {
            cache_read_input_tokens: responsesResponse.usage.input_tokens_details.cached_tokens,
          }),
          ...(responsesResponse.usage?.output_tokens_details?.reasoning_tokens && {
            output_tokens_details: {
              reasoning_tokens: responsesResponse.usage.output_tokens_details.reasoning_tokens,
            },
          }),
        },
        stop_reason: responsesResponse.status,
        content,
      })
      return c.json(responsesResponse)
    }

    consola.debug("Streaming response (/responses)")
    reqCtx.transition("streaming")

    return streamSSE(c, async (stream) => {
      const clientAbort = new AbortController()
      stream.onAbort(() => clientAbort.abort())

      const acc = createResponsesStreamAccumulator()
      const idleTimeoutMs = state.streamIdleTimeout * 1000

      let bytesIn = 0
      let eventsIn = 0

      try {
        const iterator = (response as AsyncIterable<ServerSentEventMessage>)[Symbol.asyncIterator]()

        for (;;) {
          const abortSignal = combineAbortSignals(getShutdownSignal(), clientAbort.signal)
          const result = await raceIteratorNext(iterator.next(), { idleTimeoutMs, abortSignal })

          if (result === STREAM_ABORTED || result.done) break

          const rawEvent = result.value

          if (rawEvent.data && rawEvent.data !== "[DONE]") {
            bytesIn += rawEvent.data.length
            eventsIn++

            if (reqCtx.tuiLogId) {
              tuiLogger.updateRequest(reqCtx.tuiLogId, {
                streamBytesIn: bytesIn,
                streamEventsIn: eventsIn,
              })
            }

            try {
              const event = JSON.parse(rawEvent.data) as ResponsesStreamEvent
              accumulateResponsesStreamEvent(event, acc)
              await stream.writeSSE({ event: rawEvent.event ?? event.type, data: rawEvent.data })
            } catch {
              // Ignore parse errors
            }
          }
        }

        if (!reqCtx.sessionId && acc.responseId) {
          reqCtx.setSessionId(acc.responseId)
        }
        registerResponseSession(acc.responseId, reqCtx.sessionId)
        const responseData = buildResponsesResponseData(acc, payload.model)
        reqCtx.complete(responseData)
      } catch (error) {
        consola.error("[Responses] Stream error:", error)
        reqCtx.fail(acc.model || payload.model, error)

        const errorMessage = error instanceof Error ? error.message : String(error)
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            error: {
              message: errorMessage,
              type: error instanceof StreamIdleTimeoutError ? "timeout_error" : "server_error",
            },
          }),
        })
      }
    })
  } catch (error) {
    reqCtx.setHttpHeaders(headersCapture)
    reqCtx.fail(payload.model, error)
    throw error
  }
}

export { responsesInputToMessages, responsesOutputToContent } from "~/lib/openai/responses-conversion"
