/**
 * Handler for inbound OpenAI Responses API requests.
 *
 * Dispatches to one of two execution paths:
 *  - `handleDirectResponses` (default) — passes through to Copilot's
 *    /responses upstream when the model supports it natively.
 *  - `executeResponsesViaChatCompletions` (fallback) — translates the payload
 *    to /chat/completions for models that lack /responses support or whose
 *    upstream is known-broken (see `shouldForceChatCompletionsFallback`).
 *
 * Both paths share the pre-dispatch setup performed in `handleResponses`
 * (model resolution, instructions processing, call-id normalization, history
 * recording), so the choice of path is transparent to bookkeeping.
 */

import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type {
  //
  HeadersCapture,
  RequestContext,
} from "~/lib/context/request"
import type {
  //
  ResponsesPayload,
  ResponsesResponse,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import { getRequestContextManager } from "~/lib/context/manager"
import { HTTPError } from "~/lib/error"
import { captureInboundHeaders } from "~/lib/fetch-utils"
import {
  //
  getSessionIdFromHeaders,
  registerResponseSession,
  resolveResponseSessionId,
} from "~/lib/history/store"
import {
  //
  ENDPOINT,
  isEndpointSupported,
  isResponsesSupported,
} from "~/lib/models/endpoint"
import { resolveModelName } from "~/lib/models/resolver"
import {
  //
  responsesInputToMessages,
  responsesOutputToContent,
} from "~/lib/openai/responses-conversion"
import {
  //
  accumulateResponsesStreamEvent,
  createResponsesStreamAccumulator,
} from "~/lib/openai/responses-stream-accumulator"
import { streamErrorToOpenAIErrorType } from "~/lib/openai/stream-error"
import { stripImageGenerationTool } from "~/lib/openai/responses-tool-filter"
import {
  //
  createStreamIdTracker,
  fixStreamEventIds,
} from "~/lib/openai/stream-id-sync"
import { executeRequestPipeline } from "~/lib/request/pipeline"
import { buildResponsesResponseData } from "~/lib/request/recording"
import { getShutdownSignal } from "~/lib/shutdown"
import { state } from "~/lib/state"
import {
  //
  guardSseIterable,
  type SseFrame,
} from "~/lib/stream"
import { processResponsesInstructions } from "~/lib/system-prompt"
import { tuiLogger } from "~/lib/tui"

import {
  //
  executeResponsesViaChatCompletions,
  shouldForceChatCompletionsFallback,
} from "./fallback"
import {
  //
  createResponsesAdapter,
  createResponsesStrategies,
  normalizeCallIds,
} from "./pipeline"

// Re-export conversion functions (other modules may import from ./handler)

/** Handle an inbound Responses API request */
export async function handleResponses(c: Context) {
  let payload = (c.get("injectedPayload") as ResponsesPayload | undefined) ?? (await c.req.json<ResponsesPayload>())

  // Strip the image_generation builtin tool when configured — the Copilot
  // upstream rejects it, failing the whole request (Codex CLI auto-injects it).
  stripImageGenerationTool(payload)

  // Snapshot inbound payload BEFORE mutation (model resolution, instructions
  // processing, call_id normalization) so history "original" reflects what
  // the client sent, not the half-processed in-flight version.
  const originalSnapshot = structuredClone(payload)

  // Azure deployment routes pass deployment-name via this channel instead
  // of mutating body.model. Apply AFTER snapshotting so history sees raw body.
  const azureModelOverride = c.get("azureModelOverride") as string | undefined
  if (azureModelOverride !== undefined) {
    payload.model = azureModelOverride
  }

  // Resolve model name aliases
  const clientModel = payload.model
  const resolvedModel = resolveModelName(clientModel)
  if (resolvedModel !== clientModel) {
    consola.debug(`Model name resolved: ${clientModel} → ${resolvedModel}`)
    payload.model = resolvedModel
  }

  // Decide dispatch path: direct /responses, or fallback via /chat/completions.
  // `useFallback` is true when the model can't reach /responses upstream OR
  // when the model is on the force-list (e.g. Google — Copilot's /responses
  // upstream is broken for several Gemini SKUs).
  const selectedModel = state.modelIndex.get(payload.model)
  const forceFallback = shouldForceChatCompletionsFallback(selectedModel)
  const useFallback = !isResponsesSupported(selectedModel) || forceFallback

  // Reject only when fallback is needed AND the model can't take /chat/completions.
  // Force-list vendors (e.g. Google) are exempt from this check: we force them off
  // /responses precisely because Copilot's endpoint metadata for them is unreliable,
  // so we trust they speak /chat/completions even when it isn't advertised.
  if (useFallback && !forceFallback && !isEndpointSupported(selectedModel, ENDPOINT.CHAT_COMPLETIONS)) {
    const msg = `Model "${payload.model}" does not support /responses or /chat/completions`
    throw new HTTPError(msg, 400, msg)
  }

  // Process system prompt (overrides, prepend, append from config). Runs
  // before dispatch so both paths transparently inherit config-yaml overrides.
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
    messages: responsesInputToMessages(originalSnapshot.input),
    stream: originalSnapshot.stream ?? false,
    tools: originalSnapshot.tools,
    system: originalSnapshot.instructions ?? undefined,
    payload: originalSnapshot,
  })
  reqCtx.setInboundRequestHeaders(captureInboundHeaders(c.req.raw.headers))

  // Update TUI tracker with model info
  if (tuiLogId) {
    tuiLogger.updateRequest(tuiLogId, {
      model: payload.model,
      ...(clientModel !== payload.model && { clientModel }),
    })
  }

  if (useFallback) {
    if (tuiLogId) tuiLogger.updateRequest(tuiLogId, { tags: ["via-chat-completions-fallback"] })
    return executeResponsesViaChatCompletions({ c, payload, reqCtx, selectedModel })
  }

  return handleDirectResponses({ c, payload, reqCtx })
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
  const conversationId = getSessionIdFromHeaders(c.req.raw.headers)
  // Hoisted so streamSSE.onAbort below can trigger it and the WS path can react
  // to client disconnects at the lowest level (connect / sendRequest).
  const clientAbort = new AbortController()
  const adapter = createResponsesAdapter(
    selectedModel,
    headersCapture,
    (wireRequest) => {
      reqCtx.setAttemptWireRequest(wireRequest)
    },
    (transport) => {
      reqCtx.setAttemptTransport(transport)
    },
    conversationId,
    clientAbort.signal,
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

    // Capture HTTP headers from the final attempt for history recording
    reqCtx.setHttpHeaders(headersCapture)

    const response = pipelineResult.response
    // Note: queueWaitMs is already accumulated by the pipeline via requestContext.addQueueWaitMs()

    // Determine streaming vs non-streaming based on the request payload,
    // not by inspecting the response shape (isNonStreaming checks for "choices"
    // which only exists in Chat Completions format, not Responses format)
    if (!payload.stream) {
      // Non-streaming response — build content from output items
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

    // Streaming response — forward Responses SSE events directly
    consola.debug("Streaming response (/responses)")
    reqCtx.transition("streaming")

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => clientAbort.abort())

      const acc = createResponsesStreamAccumulator()
      const idleTimeoutMs = state.streamIdleTimeout * 1000
      const idTracker = state.fixResponsesStreamIds ? createStreamIdTracker() : undefined

      // Streaming metrics for TUI footer
      let bytesIn = 0
      let eventsIn = 0

      try {
        const guarded = guardSseIterable(response as AsyncIterable<SseFrame>, {
          idleTimeoutMs,
          shutdownSignal: getShutdownSignal(),
          clientSignal: clientAbort.signal,
        })

        for await (const rawEvent of guarded) {
          if (rawEvent.data && rawEvent.data !== "[DONE]") {
            bytesIn += rawEvent.data.length
            eventsIn++

            // Update TUI footer with streaming progress
            if (reqCtx.tuiLogId) {
              tuiLogger.updateRequest(reqCtx.tuiLogId, {
                streamBytesIn: bytesIn,
                streamEventsIn: eventsIn,
              })
            }

            // Fix inconsistent IDs from upstream before processing
            const eventData = idTracker ? fixStreamEventIds(rawEvent.data, rawEvent.event, idTracker) : rawEvent.data
            let event: ResponsesStreamEvent
            try {
              event = JSON.parse(eventData) as ResponsesStreamEvent
            } catch (err) {
              // Tolerate occasional malformed frames (heartbeats, partial chunks,
              // upstream comment lines). Log at debug so we keep visibility
              // without spamming production logs.
              consola.debug(`[responses] skipping unparseable SSE frame (${err instanceof Error ? err.message : String(err)}):`, eventData.slice(0, 200))
              continue
            }

            accumulateResponsesStreamEvent(event, acc)

            // Forward the (possibly ID-corrected) event
            await stream.writeSSE({ event: rawEvent.event ?? event.type, data: eventData })
          }
        }

        // Use shared recording utility for consistent response data
        if (!reqCtx.sessionId && acc.responseId) {
          reqCtx.setSessionId(acc.responseId)
        }
        registerResponseSession(acc.responseId, reqCtx.sessionId)
        const responseData = buildResponsesResponseData(acc, payload.model)
        reqCtx.complete(responseData)
      } catch (error) {
        consola.error("[Responses] Stream error:", error)
        reqCtx.fail(acc.model || payload.model, error)

        // Send error to client as final SSE event
        const errorMessage = error instanceof Error ? error.message : String(error)
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            error: {
              message: errorMessage,
              type: streamErrorToOpenAIErrorType(error),
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
