/**
 * Fallback execution path for /v1/responses requests targeting models without
 * native /responses upstream support (Gemini, plain-chat Claude, etc.) or
 * vendors on the force-fallback list. Translates the Responses payload into a
 * Chat Completions request, calls the standard CC client, then translates the
 * response (or stream) back into Responses shape so the client is unaware.
 *
 * Companion to `handler.ts`'s `handleDirectResponses`. Both share the same
 * pre-dispatch setup in `handleResponses` (model resolution, instructions
 * processing, call-id normalization, history recording).
 */

import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type {
  //
  HeadersCapture,
  RequestContext,
} from "~/lib/context/request"
import type { SseEventRecord } from "~/lib/history"
import type { Model } from "~/lib/models/client"
import type { FormatAdapter } from "~/lib/request/pipeline"
import type { ToolNameMapper } from "~/lib/tool-name-mapper"
import type {
  //
  ChatCompletionResponse,
} from "~/types/api/openai-chat-completions"
import type {
  //
  ResponsesPayload,
  ResponsesResponse,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import { registerResponseSession } from "~/lib/history"
import { createChatCompletions } from "~/lib/openai/chat-completions-client"
import { responsesOutputToContent } from "~/lib/openai/responses-conversion"
import {
  //
  accumulateResponsesStreamEvent,
  createResponsesStreamAccumulator,
} from "~/lib/openai/responses-stream-accumulator"
import { streamErrorToOpenAIErrorType } from "~/lib/openai/stream-error"
import {
  //
  RESPONSES_NAME_BEARING_EVENTS,
  restoreResponsesEventToolNames,
  restoreResponsesOutputToolNames,
} from "~/lib/openai/tool-name-sanitize"
import {
  //
  translateCCStreamToResponsesStream,
  translateCCToResponsesResponse,
  translateResponsesToChatCompletions,
} from "~/lib/openai/translate"
import { executeRequestPipeline } from "~/lib/request/pipeline"
import { buildResponsesResponseData } from "~/lib/request/recording"
import { getShutdownSignal } from "~/lib/shutdown"
import { state } from "~/lib/state"
import {
  //
  guardSseIterable,
  type SseFrame,
} from "~/lib/stream"
import { tuiLogger } from "~/lib/tui"

import { rebuildConversationMessages } from "./conversation-rebuild"
import { createResponsesStrategies } from "./pipeline"

/**
 * Vendors whose Copilot /responses upstream is broken or absent; force
 * fallback even when the model claims to support /responses.
 *
 * Rationale: Copilot's /responses upstream returns 5xx for several Gemini
 * SKUs (observed by PR#3 author). Until Copilot stabilizes that path, route
 * Google models through /chat/completions. Update this list when upstream is
 * fixed.
 */
const FORCE_CC_VENDORS = new Set<string>(["Google"])

export function shouldForceChatCompletionsFallback(model: Model | undefined): boolean {
  return Boolean(model?.vendor && FORCE_CC_VENDORS.has(model.vendor))
}

/**
 * Restore function_call names (upstream → original) in a single Responses-shape
 * SSE data frame on the fallback path. Re-parses the frame (rather than mutating
 * the accumulated `event`) so history keeps upstream names. Best-effort: returns
 * input unchanged on parse failure / no change. No-op when `mapper` is null.
 */
function restoreFallbackStreamData(data: string, event: ResponsesStreamEvent, mapper: ToolNameMapper | null): string {
  if (!mapper) return data
  // Restore on per-item frames AND lifecycle frames whose `response.output[]`
  // carries function_call names (the synthesized terminal `response.completed`).
  if (!RESPONSES_NAME_BEARING_EVENTS.has(event.type)) return data
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return data
  }
  return restoreResponsesEventToolNames(parsed, mapper) ? JSON.stringify(parsed) : data
}

/** Generate a short, collision-safe ID using crypto.randomUUID. */
function genShortId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 11)
}

export interface FallbackOptions {
  c: Context
  payload: ResponsesPayload
  reqCtx: RequestContext
  selectedModel: Model | undefined
}

/** Translate, execute via /chat/completions, translate back. */
export async function executeResponsesViaChatCompletions(opts: FallbackOptions) {
  const { c, payload, reqCtx, selectedModel } = opts

  // 1. Rebuild prior conversation from session history (best-effort).
  //    `reqCtx.sessionId` was resolved upstream from either an explicit
  //    session header or `previous_response_id`. May return [] if unknown.
  const historyMessages = rebuildConversationMessages(reqCtx.sessionId)

  // 2. Translate payload to CC.
  const ccPayload = translateResponsesToChatCompletions(payload)

  // 3. Prepend rebuilt history (after system/developer prelude, before the
  //    current turn's user input). Empty when there's no prior session.
  if (historyMessages.length > 0) {
    const prelude = ccPayload.messages.filter((m) => m.role === "system" || m.role === "developer")
    const current = ccPayload.messages.filter((m) => m.role !== "system" && m.role !== "developer")
    ccPayload.messages = [...prelude, ...historyMessages, ...current]
  }

  // 4. Stable IDs for this exchange — same id flows through stream + non-stream
  //    paths so session registration is symmetric.
  const responseId = `resp_${genShortId()}`
  const itemId = `item_${genShortId()}`
  const clientModel = payload.model
  const headersCapture: HeadersCapture = {}

  // 5. Build adapter — translation happens INSIDE execute() so the pipeline's
  //    error handling cleanly covers translation failures (e.g. empty choices).
  const adapter: FormatAdapter<ResponsesPayload> = {
    format: "openai-responses",
    sanitize: (p) => ({ payload: p, blocksRemoved: 0, systemReminderRemovals: 0 }),
    logPayloadSize: (p) => {
      let count = 0
      if (typeof p.input === "string") count = 1
      else if (Array.isArray(p.input)) count = p.input.length
      consola.debug(`Responses-fallback payload: ${count} input item(s), model: ${p.model}`)
    },
    execute: async (_currentPayload) => {
      const ccResult = await executeWithAdaptiveRateLimit(() =>
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

      const queueWaitMs = ccResult.queueWaitMs
      if (!payload.stream) {
        return {
          result: translateCCToResponsesResponse(ccResult.result as ChatCompletionResponse, {
            responseId,
            itemId,
            clientModel,
          }),
          queueWaitMs,
        }
      }

      const translatedStream = translateCCStreamToResponsesStream(ccResult.result as AsyncIterable<ServerSentEventMessage>, { responseId, itemId, clientModel })
      return { result: translatedStream, queueWaitMs }
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

    if (!payload.stream) {
      const responsesResponse = response as ResponsesResponse
      if (!reqCtx.sessionId) reqCtx.setSessionId(responsesResponse.id)
      registerResponseSession(responsesResponse.id, reqCtx.sessionId)

      // Restore function_call names (upstream → original) on the client-facing
      // response. Computed before complete() so the forwarded content can be
      // recorded; complete() records the upstream-original content.
      const clientResponse = restoreResponsesOutputToolNames(responsesResponse, reqCtx.toolNameMapper)
      reqCtx.setForwardedResponse({ content: responsesOutputToContent(clientResponse.output) })

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
      return c.json(clientResponse)
    }

    // Stream path — register session eagerly so a follow-up request using
    // `previous_response_id` mid-stream can resolve the session before our
    // own stream finishes. The handler's responseId is authoritative
    // (the translator's response.created carries this same id).
    if (!reqCtx.sessionId) reqCtx.setSessionId(responseId)
    registerResponseSession(responseId, reqCtx.sessionId)

    consola.debug("Streaming response (Responses-fallback → /chat/completions)")
    reqCtx.transition("streaming")

    return streamSSE(c, async (stream) => {
      const clientAbort = new AbortController()
      stream.onAbort(() => clientAbort.abort())

      const acc = createResponsesStreamAccumulator()
      const idleTimeoutMs = state.streamIdleTimeout * 1000
      let bytesIn = 0
      let eventsIn = 0
      // Forwarded frames — what the client actually received (names restored).
      const forwardedSseEvents: Array<SseEventRecord> = []
      const streamStartMs = Date.now()

      try {
        const guarded = guardSseIterable(response as AsyncIterable<SseFrame>, {
          idleTimeoutMs,
          shutdownSignal: getShutdownSignal(),
          clientSignal: clientAbort.signal,
        })

        for await (const rawEvent of guarded) {
          if (!rawEvent.data || rawEvent.data === "[DONE]") continue

          bytesIn += rawEvent.data.length
          eventsIn++
          if (reqCtx.tuiLogId) {
            tuiLogger.updateRequest(reqCtx.tuiLogId, {
              streamBytesIn: bytesIn,
              streamEventsIn: eventsIn,
            })
          }

          let event: ResponsesStreamEvent
          try {
            event = JSON.parse(rawEvent.data) as ResponsesStreamEvent
          } catch (err) {
            consola.debug(
              `[responses-fallback] skipping unparseable SSE frame (${err instanceof Error ? err.message : String(err)}):`,
              rawEvent.data.slice(0, 200),
            )
            continue
          }

          accumulateResponsesStreamEvent(event, acc)
          // Restore function_call names (upstream → original) on the forwarded
          // frame only; history keeps upstream names (accumulated above).
          const forwardData = restoreFallbackStreamData(rawEvent.data, event, reqCtx.toolNameMapper)
          forwardedSseEvents.push({ offsetMs: Date.now() - streamStartMs, type: rawEvent.event ?? event.type, raw: forwardData })
          await stream.writeSSE({ event: rawEvent.event ?? event.type, data: forwardData })
        }

        const responseData = buildResponsesResponseData(acc, payload.model)
        reqCtx.setForwardedResponse({ sseEvents: forwardedSseEvents })
        reqCtx.complete(responseData)
      } catch (error) {
        consola.error("[Responses-fallback] Stream error:", error)
        reqCtx.setForwardedResponse({ sseEvents: forwardedSseEvents })
        reqCtx.fail(acc.model || payload.model, error)

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
