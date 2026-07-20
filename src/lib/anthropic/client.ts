/**
 * Direct Anthropic-style message API for Copilot.
 *
 * Owns the HTTP request lifecycle: wire payload construction, header building,
 * model-aware request enrichment (beta headers, context management),
 * and HTTP execution against Copilot's /v1/messages endpoint.
 *
 * Tool preprocessing lives in ./message-tools.ts and must be called
 * before createAnthropicMessages().
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"
import { events } from "fetch-event-stream"

import type { HeadersCapture } from "~/lib/context/request"
import type { Model } from "~/lib/models/client"
import type {
  //
  MessagesPayload,
  Message as AnthropicResponse,
  Tool,
} from "~/types/api/anthropic"

import { copilotBaseUrl } from "~/lib/copilot-api"
import {
  //
  HTTPError,
  isAbortError,
} from "~/lib/error"
import {
  //
  createResponseHeaderTimeoutSignal,
  captureHttpHeaders,
} from "~/lib/fetch-utils"
import { getShutdownSignal } from "~/lib/shutdown"
import { state } from "~/lib/state"
import { combineAbortSignals } from "~/lib/stream"
import { upstreamFetch } from "~/lib/transport/upstream-fetch"
import { summarizeToolsForDiagnostics } from "~/lib/upstream-diagnostics"

import {
  //
  prepareAnthropicRequest,
  type PreparedAnthropicRequest,
} from "./request-preparation"

/** Re-export the response type for consumers */
export type AnthropicMessageResponse = AnthropicResponse
export { prepareAnthropicRequest, type PreparedAnthropicRequest } from "./request-preparation"

// ============================================================================
// Transport primitive — postAnthropicUpstream
// ============================================================================

/** Arguments for {@link postAnthropicUpstream}. */
export interface PostAnthropicUpstreamArgs {
  /** Path appended to `copilotBaseUrl(state)` — e.g. "/v1/messages" or "/v1/messages/count_tokens". */
  path: string
  /** Prepared Anthropic wire body (from `prepareAnthropicRequest`). */
  wire: Record<string, unknown>
  /** Prepared upstream headers (auth + anthropic-version + betas + passthrough). */
  headers: Record<string, string>
  /** Resolved outbound model name — only used to tag the 529 shutdown error. */
  model: string
  /** Combined abort signal (timeout + shutdown + client-abort, per caller policy). */
  signal?: AbortSignal
}

/**
 * Thin upstream transport for prepared Anthropic wires: POST `wire` to
 * `${copilotBaseUrl}${path}` through the keepalive/timeout dispatcher, with the
 * shutdown-abort → retryable 529 wrap. Deliberately does NOT inspect
 * `response.ok`, parse the body, or branch on streaming — those stay with the
 * caller. Shared by the direct `/v1/messages` completion path and the
 * `/v1/messages/count_tokens` handler so both send byte-identical wires.
 */
export async function postAnthropicUpstream(args: PostAnthropicUpstreamArgs): Promise<Response> {
  try {
    // upstreamFetch routes through undici + our keepalive/timeout dispatcher (see
    // transport/upstream-fetch.ts), so Bun upstream connections get TCP keepalive.
    return await upstreamFetch(`${copilotBaseUrl(state)}${args.path}`, {
      method: "POST",
      headers: args.headers,
      body: JSON.stringify(args.wire),
      signal: args.signal,
    })
  } catch (error) {
    // A shutdown-caused abort becomes a retryable 529 (overloaded) so the
    // client backs off and retries against the restarted instance, rather than
    // surfacing a raw AbortError as a generic 500.
    if (getShutdownSignal().aborted && error instanceof Error && isAbortError(error)) {
      throw new HTTPError(
        "Server is shutting down",
        529,
        JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Server is shutting down" } }),
        args.model,
      )
    }
    throw error
  }
}

/** Options for {@link createAnthropicMessages}. */
export interface CreateAnthropicMessagesOptions {
  resolvedModel?: Model
  headersCapture?: HeadersCapture
  onPrepared?: (request: PreparedAnthropicRequest) => void
  /** Client-sent `anthropic-beta` header, forwarded to request preparation for merging. */
  clientAnthropicBeta?: string
  /**
   * Per-attempt preparation overrides supplied by retry strategies via the
   * pipeline's `PrepareHints`. Forwarded to `prepareAnthropicRequest`.
   *
   * `excludeBetas`: beta tokens to drop from this attempt's outbound header,
   *   on top of whatever the persistent negotiation cache already strips.
   * `rejectFields`: body fields to drop from this attempt's wire payload,
   *   on top of whatever the persistent negotiation cache already strips.
   *
   * Either can be omitted; preparation falls back to cache-only filtering.
   */
  excludeBetas?: ReadonlyArray<string>
  rejectFields?: ReadonlyArray<string>
  /**
   * Aborts the upstream fetch when the downstream client disconnects. The normal
   * route wires this from `streamSSE`'s `stream.onAbort`; callers that run their
   * own orchestration outside the streaming handler (e.g. the web_search double-
   * hop) pass it so a client cancel terminates the upstream hop instead of
   * letting it run to `timeouts.response_header`. Folded into the upstream fetch signal.
   */
  clientAbortSignal?: AbortSignal
  /**
   * The filtered client query string (with a leading `?`, or `""`) to append to
   * the upstream `/v1/messages` URL. The web_search double-hop runs outside the
   * driver transport adapter (which does this for the main path), so its caller
   * threads `reqCtx.query.forwarded` here to keep the bypass hop consistent.
   */
  forwardedQuery?: string
}

// ============================================================================
// Main entry point — createAnthropicMessages
// ============================================================================

/**
 * Create messages using Anthropic-style API directly.
 * Calls Copilot's native Anthropic endpoint for Anthropic-vendor models.
 */
export async function createAnthropicMessages(
  payload: MessagesPayload,
  opts?: CreateAnthropicMessagesOptions,
): Promise<AnthropicMessageResponse | AsyncGenerator<ServerSentEventMessage>> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const prepared = prepareAnthropicRequest(payload, opts)
  opts?.onPrepared?.({
    wire: prepared.wire,
    headers: prepared.headers,
  })

  const { wire, headers } = prepared
  const model = wire.model as string
  const messages = wire.messages as MessagesPayload["messages"]
  const tools = wire.tools as Array<Tool> | undefined
  const thinking = wire.thinking as MessagesPayload["thinking"]

  consola.debug("Sending direct Anthropic request to Copilot /v1/messages")

  // For NON-streaming requests, fold the shutdown signal into the fetch signal
  // so a Phase 3 abort interrupts the (long) header-wait instead of hanging
  // until responseHeaderTimeout / Phase 4 force-close. Streaming requests deliberately
  // omit it: the stream guard in processAnthropicStream owns shutdown
  // for the streamed body, and aborting the fetch mid-body would tear down the
  // ReadableStream underneath that guard.
  // `clientAbortSignal` (when supplied) is always folded in: a client
  // disconnect should terminate the upstream call on both stream and
  // non-stream paths.
  // `model` = `wire.model` (the resolved outbound name, same key space as send.ts's
  // `modelId`) — NOT `payload.model` (client's raw name), so the per-model timeout
  // key matches what the request is actually sent as.
  const upstreamSignal = combineAbortSignals(
    createResponseHeaderTimeoutSignal(model),
    payload.stream ? undefined : getShutdownSignal(),
    opts?.clientAbortSignal,
  )

  const response = await postAnthropicUpstream({
    // web_search bypass hop: append the forwarded client query to the upstream path
    // (main path does this in the driver transport adapter; Step 7 of client-query-forwarding).
    path: `/v1/messages${opts?.forwardedQuery ?? ""}`,
    wire,
    headers,
    model,
    signal: upstreamSignal,
  })

  if (opts?.headersCapture) {
    captureHttpHeaders(opts.headersCapture, headers, response)
  }

  if (!response.ok) {
    const responseText = await response.text()
    consola.debug("Request failed:", {
      model,
      max_tokens: wire.max_tokens,
      stream: wire.stream,
      toolCount: tools?.length ?? 0,
      thinking,
      messageCount: messages.length,
    })
    // The `invalid_reasoning_effort` learn-then-retry that used to live here as a
    // 2-attempt inner loop is now the pipeline's `effort-learning` strategy
    // (P0.4) — this client is single-shot. On opaque 400s, scan the wire tools
    // for schema keywords / names the upstream commonly rejects, and attach
    // hint-only diagnostics. Logging is the consumer's job (forwardError) — the
    // client only generates + attaches.
    const diagnostics = response.status === 400 ? summarizeToolsForDiagnostics(tools) : undefined
    throw new HTTPError("Failed to create Anthropic messages", response.status, responseText, model, response.headers, diagnostics)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as AnthropicMessageResponse
}
