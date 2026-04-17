/**
 * Responses API client for Copilot /responses endpoint.
 * Follows the same pattern as chat-completions-client.ts but targets the /responses endpoint.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"
import { events } from "fetch-event-stream"

import type { HeadersCapture } from "~/lib/context/request"
import type { RequestTransport } from "~/lib/history"
import type { Model } from "~/lib/models/client"
import type { ResponsesPayload, ResponsesResponse, ResponsesStreamEvent } from "~/types/api/openai-responses"

import { copilotBaseUrl } from "~/lib/copilot-api"
import { HTTPError } from "~/lib/error"
import { createFetchSignal, captureHttpHeaders, sanitizeHeadersForHistory } from "~/lib/fetch-utils"
import { isWsResponsesSupported } from "~/lib/models/endpoint"
import { state } from "~/lib/state"

import { prepareResponsesRequest, type PreparedOpenAIRequest } from "./request-preparation"
import { getUpstreamWsManager } from "./upstream-ws"

interface CreateResponsesOptions {
  resolvedModel?: Model
  headersCapture?: HeadersCapture
  onPrepared?: (request: PreparedOpenAIRequest<ResponsesPayload>) => void
  onTransport?: (transport: RequestTransport) => void
  /**
   * Optional conversation identifier (e.g. from X-Conversation-Id header).
   * Used as a fallback upstream-WS reuse key when `previous_response_id` is
   * absent. Mirrors GHC per-conversation WS pattern (#4827).
   */
  conversationId?: string
}

export { type PreparedOpenAIRequest, prepareResponsesRequest } from "./request-preparation"

/** Call Copilot /responses endpoint */
export const createResponses = async (
  payload: ResponsesPayload,
  opts?: CreateResponsesOptions,
): Promise<ResponsesResponse | AsyncGenerator<ServerSentEventMessage>> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const prepared = prepareResponsesRequest(payload, opts)
  opts?.onPrepared?.({
    wire: prepared.wire,
    headers: sanitizeHeadersForHistory(prepared.headers),
  })
  const { wire } = prepared
  let usedFallback = false

  if (wire.stream && canUseUpstreamWebSocket(opts?.resolvedModel)) {
    const manager = getUpstreamWsManager()
    const previousResponseId = typeof wire.previous_response_id === "string" ? wire.previous_response_id : undefined
    const reusable =
      previousResponseId || opts?.conversationId ?
        manager.findReusable({
          previousResponseId,
          conversationId: opts?.conversationId,
          model: wire.model,
        })
      : undefined
    const connection =
      reusable
      ?? (await manager.create({ headers: prepared.headers, model: wire.model, conversationId: opts?.conversationId }))

    try {
      if (!connection.isOpen) {
        await connection.connect({ signal: createFetchSignal() })
      }

      const iterator = connection.sendRequest(wire)[Symbol.asyncIterator]()
      const first = await awaitFirstEvent(iterator)
      manager.recordSuccessfulStart()
      opts?.onTransport?.("upstream-ws")

      return (async function* () {
        yield toSseMessage(first)
        for (;;) {
          const result = await iterator.next()
          if (result.done) return
          yield toSseMessage(result.value)
        }
      })()
    } catch (error) {
      manager.recordFallback()
      opts?.onTransport?.("upstream-ws-fallback")
      usedFallback = true
      connection.close()

      consola.warn(
        `[responses] Upstream WS failed before first event, falling back to HTTP `
          + `(${manager.consecutiveFallbacks}/3): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  if (!usedFallback) {
    opts?.onTransport?.("http")
  }
  return createResponsesViaHttp(prepared, opts?.headersCapture)
}

function canUseUpstreamWebSocket(model: Model | undefined): boolean {
  const manager = getUpstreamWsManager()
  return state.upstreamWebSocket && !manager.temporarilyDisabled && !manager.stopped && isWsResponsesSupported(model)
}

async function createResponsesViaHttp(
  prepared: PreparedOpenAIRequest<ResponsesPayload>,
  headersCapture?: HeadersCapture,
): Promise<ResponsesResponse | AsyncGenerator<ServerSentEventMessage>> {
  const { wire, headers } = prepared
  // Apply fetch timeout if configured (connection + response headers)
  const fetchSignal = createFetchSignal()

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(wire),
    signal: fetchSignal,
  })

  // Capture HTTP headers for history (before error check — capture even on failure)
  if (headersCapture) {
    captureHttpHeaders(headersCapture, headers, response)
  }

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw await HTTPError.fromResponse("Failed to create responses", response, wire.model)
  }

  if (wire.stream) {
    return events(response)
  }

  return (await response.json()) as ResponsesResponse
}

async function awaitFirstEvent(iterator: AsyncIterator<ResponsesStreamEvent>): Promise<ResponsesStreamEvent> {
  const signal = createFetchSignal()
  if (!signal) {
    const first = await iterator.next()
    if (first.done) throw new Error("Upstream WebSocket closed before first event")
    return first.value
  }

  return await new Promise<ResponsesStreamEvent>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      reject(new Error("Upstream WebSocket timed out before first event"))
    }

    signal.addEventListener("abort", onAbort, { once: true })
    void iterator
      .next()
      .then((result) => {
        signal.removeEventListener("abort", onAbort)
        if (result.done) {
          reject(new Error("Upstream WebSocket closed before first event"))
          return
        }
        resolve(result.value)
      })
      .catch((error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
  })
}

function toSseMessage(event: ResponsesStreamEvent): ServerSentEventMessage {
  return {
    event: event.type,
    data: JSON.stringify(event),
  }
}
