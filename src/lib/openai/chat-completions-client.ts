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
import { summarizeToolsForDiagnostics } from "~/lib/upstream-diagnostics"

import {
  //
  prepareChatCompletionsRequest,
  type PreparedOpenAIRequest,
} from "./request-preparation"

interface CreateChatCompletionsOptions {
  resolvedModel?: Model
  headersCapture?: HeadersCapture
  onPrepared?: (request: PreparedOpenAIRequest<ChatCompletionsPayload>) => void
  /**
   * Aborts the upstream fetch when the downstream client disconnects. The
   * route bridges this from `c.req.raw.signal` (and, on the streaming branch,
   * also from `streamSSE`'s `onAbort`). Folded into the upstream fetch signal
   * so a client cancel terminates BOTH stream and non-stream paths — without
   * it, an abandoned non-streaming request runs to the configured
   * `timeouts.response_header` (default 300s) while accumulating response
   * buffer the client will never read.
   */
  clientAbortSignal?: AbortSignal
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
  // `clientAbortSignal` (when supplied) is always folded in: a client
  // disconnect should terminate the upstream call on both stream and
  // non-stream paths — without it, an abandoned non-stream request would run
  // to `timeouts.response_header` while the response body is no longer wanted.
  const fetchSignal = combineAbortSignals(createFetchSignal(), wire.stream ? undefined : getShutdownSignal(), opts?.clientAbortSignal)

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
    // On opaque 400s, scan the wire tools for schema keywords / names the
    // upstream commonly rejects, and attach hint-only diagnostics.
    const diagnostics = response.status === 400 ? summarizeToolsForDiagnostics(wire.tools) : undefined
    throw await HTTPError.fromResponse("Failed to create chat completions", response, wire.model, diagnostics)
  }

  if (wire.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}
