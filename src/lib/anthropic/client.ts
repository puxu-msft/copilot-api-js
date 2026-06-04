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
import { HTTPError } from "~/lib/error"
import {
  //
  createFetchSignal,
  captureHttpHeaders,
  sanitizeHeadersForHistory,
} from "~/lib/fetch-utils"
import { state } from "~/lib/state"

import {
  //
  prepareAnthropicRequest,
  learnEffortsFromError,
  type PreparedAnthropicRequest,
} from "./request-preparation"

/** Re-export the response type for consumers */
export type AnthropicMessageResponse = AnthropicResponse
export { prepareAnthropicRequest, type PreparedAnthropicRequest } from "./request-preparation"

interface CreateAnthropicMessagesOptions {
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

  // Up to 2 attempts: first normal, second after learning invalid_reasoning_effort
  for (let attempt = 0; attempt < 2; attempt++) {
    const prepared = prepareAnthropicRequest(payload, opts)
    opts?.onPrepared?.({
      wire: prepared.wire,
      headers: sanitizeHeadersForHistory(prepared.headers),
    })

    const { wire, headers } = prepared
    const model = wire.model as string
    const messages = wire.messages as MessagesPayload["messages"]
    const tools = wire.tools as Array<Tool> | undefined
    const thinking = wire.thinking as MessagesPayload["thinking"]

    consola.debug("Sending direct Anthropic request to Copilot /v1/messages")

    const fetchSignal = createFetchSignal()

    const response = await fetch(`${copilotBaseUrl(state)}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(wire),
      signal: fetchSignal,
    })

    if (opts?.headersCapture) {
      captureHttpHeaders(opts.headersCapture, headers, response)
    }

    if (!response.ok) {
      const responseText = await response.text()
      // Learn supported efforts from upstream error and retry once
      if (attempt === 0 && response.status === 400 && learnEffortsFromError(responseText)) {
        consola.debug("Retrying Anthropic request after learning supported efforts")
        continue
      }
      consola.debug("Request failed:", {
        model,
        max_tokens: wire.max_tokens,
        stream: wire.stream,
        toolCount: tools?.length ?? 0,
        thinking,
        messageCount: messages.length,
      })
      throw new HTTPError("Failed to create Anthropic messages", response.status, responseText, model, response.headers)
    }

    if (payload.stream) {
      return events(response)
    }

    return (await response.json()) as AnthropicMessageResponse
  }
  // Unreachable (loop always returns or throws)
  throw new Error("createAnthropicMessages: unreachable state")
}
