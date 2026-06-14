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
import type { SseEventRecord } from "~/lib/history/store"
import type { ToolNameMapper } from "~/lib/tool-name-mapper"
import type {
  //
  ResponsesPayload,
  ResponsesResponse,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import { bridgeClientAbort } from "~/lib/abort-bridge"
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
import { stripImageGenerationTool } from "~/lib/openai/responses-tool-filter"
import { streamErrorToOpenAIErrorType } from "~/lib/openai/stream-error"
import {
  //
  createStreamIdTracker,
  fixStreamEventIds,
} from "~/lib/openai/stream-id-sync"
import {
  //
  applyResponsesToolNameSanitization,
  buildResponsesToolNameMapper,
  RESPONSES_NAME_BEARING_EVENTS,
  restoreResponsesEventToolNames,
  restoreResponsesOutputToolNames,
} from "~/lib/openai/tool-name-sanitize"
import { executeRequestPipeline } from "~/lib/request/pipeline"
import { buildResponsesResponseData } from "~/lib/request/recording"
import { settleStreamingFailure } from "~/lib/request/stream-settle"
import { getShutdownSignal } from "~/lib/shutdown"
import { state } from "~/lib/state"
import {
  //
  guardSseIterable,
  type SseFrame,
} from "~/lib/stream"
import { processResponsesInstructions } from "~/lib/system-prompt"

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

  // Create request context (Responses API is a distinct OpenAI-format endpoint)
  const manager = getRequestContextManager()
  const contentLengthHeader = c.req.header("content-length")
  const reqBodySize = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : undefined
  const reqCtx = manager.create({
    endpoint: "openai-responses",
    sessionId: getSessionIdFromHeaders(c.req.raw.headers) ?? resolveResponseSessionId(payload.previous_response_id),
    rawPath: c.req.path,
    method: c.req.method,
    path: c.req.path,
    ...(reqBodySize !== undefined && Number.isFinite(reqBodySize) && { requestBodySize: reqBodySize }),
  })
  c.set("requestContext", reqCtx)

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

  // Build the per-request tool-name sanitization mapper from the client's tool
  // definitions, then rename tool names to their upstream form on the working
  // payload. The original snapshot above keeps the client's original names for
  // history; both dispatch paths restore upstream → original on the response.
  const toolNameMapper = buildResponsesToolNameMapper(payload, selectedModel?.vendor)
  reqCtx.setToolNameMapper(toolNameMapper)
  payload = applyResponsesToolNameSanitization(payload, toolNameMapper)

  reqCtx.setResolvedModel({
    resolved: payload.model,
    ...(clientModel !== payload.model && { client: clientModel }),
  })

  if (useFallback) {
    reqCtx.recordFeature("via-chat-completions-fallback")
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
  // Also bridged to the inbound HTTP signal here so non-streaming requests
  // (which never call streamSSE) still tear down the upstream fetch on client
  // disconnect — otherwise an abandoned non-stream request runs to the
  // configured `timeouts.response_header` (default 300s) and accumulates a
  // response buffer that will never be read.
  const clientAbort = new AbortController()
  const detachClientAbort = bridgeClientAbort(c, clientAbort)
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

      // Restore function_call names (upstream → original) on the client-facing
      // response. Computed before complete() so the forwarded (client-facing)
      // content can be recorded; complete() records the upstream-original content.
      const clientResponse = restoreResponsesOutputToolNames(responsesResponse, reqCtx.toolNameMapper)
      reqCtx.setForwardedResponse({ content: responsesOutputToContent(clientResponse.output) })

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
      detachClientAbort()
      return c.json(clientResponse)
    }

    // Streaming response — forward Responses SSE events directly
    consola.debug("Streaming response (/responses)")
    reqCtx.transition("streaming")

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => clientAbort.abort())

      const acc = createResponsesStreamAccumulator()
      const idleTimeoutMs = state.streamIdleTimeout * 1000
      const idTracker = state.fixResponsesStreamIds ? createStreamIdTracker() : undefined

      // Forwarded SSE frames — what the client actually received (ID-fixed + names restored).
      const forwardedSseEvents: Array<SseEventRecord> = []
      const streamStartMs = Date.now()

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

            reqCtx.recordStreamProgress({ bytesIn, eventsIn })

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

            // Forward the (possibly ID-corrected) event, restoring function_call
            // names (upstream → original) when sanitization is active. History
            // keeps the upstream names (accumulated above).
            const forwardData = restoreResponsesStreamData(eventData, event, reqCtx.toolNameMapper)
            forwardedSseEvents.push({ offsetMs: Date.now() - streamStartMs, type: rawEvent.event ?? event.type, raw: forwardData })
            await stream.writeSSE({ event: rawEvent.event ?? event.type, data: forwardData })
          }
        }

        // Use shared recording utility for consistent response data
        if (!reqCtx.sessionId && acc.responseId) {
          reqCtx.setSessionId(acc.responseId)
        }
        registerResponseSession(acc.responseId, reqCtx.sessionId)
        const responseData = buildResponsesResponseData(acc, payload.model)
        reqCtx.setForwardedResponse({ sseEvents: forwardedSseEvents })
        reqCtx.complete(responseData)
      } catch (error) {
        reqCtx.setForwardedResponse({ sseEvents: forwardedSseEvents })
        // Uniform terminal settle: client disconnect → `aborted` (return, no
        // frame); else → `fail()` and emit the OpenAI error frame.
        const partial = { usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens } }
        if (settleStreamingFailure({ reqCtx, error, model: acc.model || payload.model, partial })) {
          consola.debug("[Responses] Client disconnected mid-stream — recording aborted")
          return
        }
        consola.error("[Responses] Stream error:", error)

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
      } finally {
        // Bridge listener installed at the top of handleDirectResponses must
        // be removed once we exit the stream path — without this the inbound
        // raw.signal retains one strong reference per request until GC.
        detachClientAbort()
      }
    })
  } catch (error) {
    reqCtx.setHttpHeaders(headersCapture)
    reqCtx.fail(payload.model, error)
    detachClientAbort()
    throw error
  }
}

export { responsesInputToMessages, responsesOutputToContent } from "~/lib/openai/responses-conversion"

/**
 * Restore function_call names (upstream → original) in a single Responses SSE
 * data frame for forwarding. Re-parses `eventData` (rather than mutating the
 * already-accumulated `event`) so history keeps the upstream names. Best-effort:
 * returns the input unchanged on parse failure or when nothing changed. No-op
 * when `mapper` is null.
 */
function restoreResponsesStreamData(eventData: string, event: ResponsesStreamEvent, mapper: ToolNameMapper | null): string {
  if (!mapper) return eventData
  // function names appear on `item` (output_item.added/done) AND inside the full
  // `response.output[]` of lifecycle events (created/in_progress/completed/
  // failed/incomplete) — clients reconstruct from the terminal `completed`, so
  // both must be restored. Other event types never carry a name.
  if (!RESPONSES_NAME_BEARING_EVENTS.has(event.type)) return eventData
  let parsed: unknown
  try {
    parsed = JSON.parse(eventData)
  } catch {
    return eventData
  }
  return restoreResponsesEventToolNames(parsed, mapper) ? JSON.stringify(parsed) : eventData
}
