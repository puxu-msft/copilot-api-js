/**
 * Responses API client for Copilot /responses endpoint.
 * Follows the same pattern as chat-completions-client.ts but targets the /responses endpoint.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"
import { events } from "fetch-event-stream"

import type { HeadersCapture } from "~/lib/context/request"
import type { Model } from "~/lib/models/client"
import type { ResponsesPayload, ResponsesResponse } from "~/types/api/openai-responses"

import { copilotBaseUrl } from "~/lib/copilot-api"
import { HTTPError } from "~/lib/error"
import { createFetchSignal, captureHttpHeaders, sanitizeHeadersForHistory } from "~/lib/fetch-utils"
import { state } from "~/lib/state"
import { prepareResponsesRequest, type PreparedOpenAIRequest } from "./request-preparation"

interface CreateResponsesOptions {
  resolvedModel?: Model
  headersCapture?: HeadersCapture
  onPrepared?: (request: PreparedOpenAIRequest<ResponsesPayload>) => void
}

export { prepareResponsesRequest, type PreparedOpenAIRequest } from "./request-preparation"

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
  if (opts?.headersCapture) {
    captureHttpHeaders(opts.headersCapture, headers, response)
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
