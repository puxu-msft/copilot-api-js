/**
 * Responses API client for Copilot /responses endpoint.
 * Follows the same pattern as chat-completions-client.ts but targets the /responses endpoint.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import type { HeadersCapture } from "~/lib/context/request"
import type { RequestTransport } from "~/lib/history"
import type { Model } from "~/lib/models/client"
import type {
  //
  ResponsesPayload,
  ResponsesResponse,
} from "~/types/api/openai-responses"

import { getTokenCredentials } from "~/lib/token"
import { sendUpstreamHttp } from "~/lib/transport/send"

import {
  //
  prepareResponsesRequest,
  type PreparedOpenAIRequest,
} from "./request-preparation"
import {
  //
  attemptUpstreamResponsesWs,
  canUseUpstreamWebSocket,
} from "./upstream-ws-attempt"

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
  /**
   * Caller-supplied abort signal (e.g. client disconnect). Propagated into
   * the upstream WS request so the connection is freed promptly when the
   * client goes away.
   */
  clientAbortSignal?: AbortSignal
}

export { type PreparedOpenAIRequest, prepareResponsesRequest } from "./request-preparation"

/** Call Copilot /responses endpoint */
export const createResponses = async (
  payload: ResponsesPayload,
  opts?: CreateResponsesOptions,
): Promise<ResponsesResponse | AsyncGenerator<ServerSentEventMessage>> => {
  if (!getTokenCredentials().copilotToken) throw new Error("Copilot token not found")

  const prepared = prepareResponsesRequest(payload, opts)
  opts?.onPrepared?.({
    wire: prepared.wire,
    headers: prepared.headers,
  })
  const { wire } = prepared
  let usedFallback = false

  if (wire.stream && canUseUpstreamWebSocket(opts?.resolvedModel, wire.model)) {
    const result = await attemptUpstreamResponsesWs(prepared, opts)
    if (result.kind === "ok") {
      opts?.onTransport?.("upstream-ws")
      return result.generator
    }
    opts?.onTransport?.("upstream-ws-fallback")
    usedFallback = true
  }

  if (!usedFallback) {
    opts?.onTransport?.("http")
  }
  return createResponsesViaHttp(prepared, opts?.headersCapture)
}

async function createResponsesViaHttp(
  prepared: PreparedOpenAIRequest<ResponsesPayload>,
  headersCapture?: HeadersCapture,
): Promise<ResponsesResponse | AsyncGenerator<ServerSentEventMessage>> {
  const { wire, headers } = prepared

  // Pure send/receive lives in transport/send.ts (shared with the Chat
  // Completions client). The Responses HTTP path historically did NOT fold the
  // client-abort signal into the upstream fetch, so it is omitted here to stay
  // byte-equivalent (streaming still omits the shutdown signal — the stream
  // guard in the handler owns shutdown for the streamed body).
  return (await sendUpstreamHttp({
    endpointPath: "/responses",
    headers,
    body: wire,
    stream: wire.stream,
    errorLabel: "Failed to create responses",
    modelId: wire.model,
    diagnosticsTools: wire.tools,
    headersCapture,
  })) as ResponsesResponse | AsyncGenerator<ServerSentEventMessage>
}
