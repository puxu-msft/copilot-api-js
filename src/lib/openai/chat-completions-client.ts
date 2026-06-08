import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"
import { events } from "fetch-event-stream"

import type { HeadersCapture } from "~/lib/context/request"
import type { Model } from "~/lib/models/client"
import type {
  //
  ChatCompletionsPayload,
  ChatCompletionResponse,
} from "~/types/api/openai-chat-completions"

import { copilotBaseUrl } from "~/lib/copilot-api"
import { HTTPError } from "~/lib/error"
import {
  //
  createFetchSignal,
  captureHttpHeaders,
  DISABLE_BUILTIN_FETCH_TIMEOUT,
  sanitizeHeadersForHistory,
} from "~/lib/fetch-utils"
import { getShutdownSignal } from "~/lib/shutdown"
import { state } from "~/lib/state"
import { combineAbortSignals } from "~/lib/stream"

import {
  //
  prepareChatCompletionsRequest,
  type PreparedOpenAIRequest,
} from "./request-preparation"

interface CreateChatCompletionsOptions {
  resolvedModel?: Model
  headersCapture?: HeadersCapture
  onPrepared?: (request: PreparedOpenAIRequest<ChatCompletionsPayload>) => void
}

export { prepareChatCompletionsRequest, type PreparedOpenAIRequest } from "./request-preparation"

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  opts?: CreateChatCompletionsOptions,
): Promise<ChatCompletionResponse | AsyncGenerator<ServerSentEventMessage>> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const prepared = prepareChatCompletionsRequest(payload, opts)
  opts?.onPrepared?.({
    wire: prepared.wire,
    headers: sanitizeHeadersForHistory(prepared.headers),
  })
  const { wire, headers } = prepared

  // Apply fetch timeout if configured (connection + response headers). For
  // non-streaming requests, also fold in the shutdown signal so a Phase 3 abort
  // interrupts the (long) header-wait; streaming omits it (the stream guard in
  // the handler owns shutdown for the streamed body).
  const fetchSignal = combineAbortSignals(createFetchSignal(), wire.stream ? undefined : getShutdownSignal())

  const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(wire),
    signal: fetchSignal,
    ...DISABLE_BUILTIN_FETCH_TIMEOUT,
  })

  // Capture HTTP headers for history (before error check — capture even on failure)
  if (opts?.headersCapture) {
    captureHttpHeaders(opts.headersCapture, headers, response)
  }

  if (!response.ok) {
    consola.error("Failed to create chat completions", response)
    throw await HTTPError.fromResponse("Failed to create chat completions", response, wire.model)
  }

  if (wire.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}
