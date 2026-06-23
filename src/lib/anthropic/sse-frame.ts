/**
 * Build an Anthropic SSE frame, deriving the `event:` line from the payload `type`.
 *
 * Every Anthropic stream frame's SSE event name equals its JSON `type`
 * (`content_block_start`, `content_block_delta`, `message_delta`, …). A synthesized
 * frame that carries only `data:` decodes to `sse.event === null` in the
 * `@anthropic-ai/sdk` stream decoder, which dispatches on the event NAME (not the
 * parsed `data.type`) and silently DROPS unknown/`null` events — it does not even
 * apply the SSE-spec `"message"` default. So every synthesized Anthropic frame MUST
 * carry the matching `event:` line, or SDK clients (Claude Code) lose it. Routing all
 * synthesis through this single helper keeps that invariant from drifting.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

/** An Anthropic stream event payload — its `type` is also the SSE event name. */
export interface AnthropicEventPayload extends Record<string, unknown> {
  type: string
}

/** Serialize an Anthropic stream event into an SSE frame with `event:` derived from `type`. */
export function anthropicSseFrame(payload: AnthropicEventPayload): ServerSentEventMessage {
  return { event: payload.type, data: JSON.stringify(payload) }
}
