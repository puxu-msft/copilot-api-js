/**
 * Responses API client for Copilot /responses endpoint.
 * Follows the same pattern as client.ts but targets the /responses endpoint.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"
import { events } from "fetch-event-stream"

import type { HeadersCapture } from "~/lib/context/request"
import type { Model } from "~/lib/models/client"
import type { ResponsesPayload, ResponsesResponse, ResponsesInputItem } from "~/types/api/openai-responses"

import { copilotHeaders, copilotBaseUrl } from "~/lib/copilot-api"
import { HTTPError } from "~/lib/error"
import { createFetchSignal, captureHttpHeaders, sanitizeHeadersForHistory } from "~/lib/fetch-utils"
import { state } from "~/lib/state"

import type { PreparedOpenAIRequest } from "./client"

interface CreateResponsesOptions {
  resolvedModel?: Model
  headersCapture?: HeadersCapture
  onPrepared?: (request: PreparedOpenAIRequest<ResponsesPayload>) => void
}

export function prepareResponsesRequest(
  payload: ResponsesPayload,
  opts?: Pick<CreateResponsesOptions, "resolvedModel">,
): PreparedOpenAIRequest<ResponsesPayload> {
  const wire = payload

  // Check for vision content in input
  const enableVision = hasVisionContent(wire.input)

  // Determine if this is an agent call (has assistant or function_call items in history)
  const isAgentCall =
    Array.isArray(wire.input)
    && wire.input.some(
      (item) => item.role === "assistant" || item.type === "function_call" || item.type === "function_call_output",
    )

  // Only set vision header if model supports it (default to true when unknown)
  const modelSupportsVision = opts?.resolvedModel?.capabilities?.supports?.vision !== false

  const headers: Record<string, string> = {
    ...copilotHeaders(state, {
      vision: enableVision && modelSupportsVision,
      modelRequestHeaders: opts?.resolvedModel?.request_headers,
      intent: isAgentCall ? "conversation-agent" : "conversation-panel",
    }),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  return { wire, headers }
}

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

/** Check if the input contains any image content */
function hasVisionContent(input: string | Array<ResponsesInputItem>): boolean {
  if (typeof input === "string") return false
  return input.some(
    (item) => Array.isArray(item.content) && item.content.some((part) => "type" in part && part.type === "input_image"),
  )
}
