import type { ServerSentEventMessage } from "fetch-event-stream"

import type { HeadersCapture } from "~/lib/context/request"
import type { Model } from "~/lib/models/client"
import type {
  //
  ChatCompletionsPayload,
  ChatCompletionResponse,
} from "~/types/api/openai-chat-completions"

import { state } from "~/lib/state"
import { sendUpstreamHttp } from "~/lib/transport/send"

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
    headers: prepared.headers,
  })
  const { wire, headers } = prepared

  // Pure send/receive lives in transport/send.ts (shared with the Responses HTTP
  // path). Request preparation stays here. `clientAbortSignal` is folded into the
  // upstream fetch signal so a client cancel terminates both stream and non-stream
  // paths — without it, an abandoned non-stream request would run to
  // `timeouts.response_header` while the response body is no longer wanted.
  return (await sendUpstreamHttp({
    endpointPath: "/chat/completions",
    headers,
    body: wire,
    stream: wire.stream,
    errorLabel: "Failed to create chat completions",
    modelId: wire.model,
    diagnosticsTools: wire.tools,
    headersCapture: opts?.headersCapture,
    clientAbortSignal: opts?.clientAbortSignal,
  })) as ChatCompletionResponse | AsyncGenerator<ServerSentEventMessage>
}
