/**
 * Handler for inbound OpenAI Responses API requests.
 * Routes directly to Copilot /responses endpoint.
 * Models that do not support /responses get a 400 error.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { HeadersCapture, RequestContext } from "~/lib/context/request"
import type { ResponsesPayload, ResponsesResponse, ResponsesStreamEvent } from "~/types/api/openai-responses"

import { getRequestContextManager } from "~/lib/context/manager"
import { HTTPError } from "~/lib/error"
import { ENDPOINT, isEndpointSupported } from "~/lib/models/endpoint"
import { resolveModelName } from "~/lib/models/resolver"
import { responsesInputToMessages, responsesOutputToContent } from "~/lib/openai/responses-conversion"
import {
  accumulateResponsesStreamEvent,
  createResponsesStreamAccumulator,
} from "~/lib/openai/responses-stream-accumulator"
import { executeRequestPipeline } from "~/lib/request/pipeline"
import { buildResponsesResponseData } from "~/lib/request/recording"
import { getShutdownSignal } from "~/lib/shutdown"
import { state } from "~/lib/state"
import { STREAM_ABORTED, StreamIdleTimeoutError, combineAbortSignals, raceIteratorNext } from "~/lib/stream"
import { processResponsesInstructions } from "~/lib/system-prompt"
import { tuiLogger } from "~/lib/tui"

import { createResponsesAdapter, createResponsesStrategies, normalizeCallIds } from "./pipeline"

// Re-export conversion functions (other modules may import from ./handler)

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

  // Validate that the model supports /responses endpoint
  const selectedModel = state.modelIndex.get(payload.model)
  if (!isEndpointSupported(selectedModel, ENDPOINT.RESPONSES)) {
    const msg = `Model "${payload.model}" does not support the ${ENDPOINT.RESPONSES} endpoint`
    throw new HTTPError(msg, 400, msg)
  }

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
  const reqCtx = manager.create({ endpoint: "openai-responses", tuiLogId })

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
  const adapter = createResponsesAdapter(selectedModel, headersCapture)
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
    reqCtx.addQueueWaitMs(pipelineResult.queueWaitMs)

    // Determine streaming vs non-streaming based on the request payload,
    // not by inspecting the response shape (isNonStreaming checks for "choices"
    // which only exists in Chat Completions format, not Responses format)
    if (!payload.stream) {
      // Non-streaming response — build content from output items
      const responsesResponse = response as ResponsesResponse
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
      const clientAbort = new AbortController()
      stream.onAbort(() => clientAbort.abort())

      const acc = createResponsesStreamAccumulator()
      const idleTimeoutMs = state.streamIdleTimeout * 1000

      // Streaming metrics for TUI footer
      let bytesIn = 0
      let eventsIn = 0

      try {
        const iterator = (response as AsyncIterable<ServerSentEventMessage>)[Symbol.asyncIterator]()
        const abortSignal = combineAbortSignals(getShutdownSignal(), clientAbort.signal)

        for (;;) {
          const result = await raceIteratorNext(iterator.next(), { idleTimeoutMs, abortSignal })

          if (result === STREAM_ABORTED) break
          if (result.done) break

          const rawEvent = result.value

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

            try {
              const event = JSON.parse(rawEvent.data) as ResponsesStreamEvent
              accumulateResponsesStreamEvent(event, acc)

              // Forward the event as-is (including SSE event type field)
              await stream.writeSSE({ event: rawEvent.event ?? event.type, data: rawEvent.data })
            } catch {
              // Ignore parse errors
            }
          }
        }

        // Use shared recording utility for consistent response data
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
