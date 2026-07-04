/**
 * Block-aware Anthropic keepalive frame builder — the covering matrix proven in
 * exp/cc-idle-280s/REPORT.md. Shared by BOTH the v4 sink path (handler-v4) and the legacy
 * web_search bypass heartbeat (streaming-pump), so it lives here (not in handler-v4) to avoid
 * the handler-v4 → web-search-handler → web-search-direct import cycle.
 *
 * `content_delta` mode injects an EMPTY delta matching the current open block, which resets
 * Claude Code's 300s no-real-content idle deadline that a bare `event: ping` does NOT (a ping is
 * not counted as a "chunk"). `ping` mode / no open block / redacted_thinking / unknown → bare ping.
 */

import type { OpenBlock } from "~/lib/pipeline/client-sink"
import type { ClientFrame } from "~/lib/pipeline/types"

/** The Anthropic-protocol synthetic ping keepalive frame (the fallback + the classic behavior). */
export const ANTHROPIC_PING: ClientFrame = { event: "ping", data: JSON.stringify({ type: "ping" }) }

/** Build a content_block_delta keepalive frame (index-matched to the open block). */
function anthropicKeepaliveDelta(index: number, delta: Record<string, unknown>): ClientFrame {
  return { event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index, delta }) }
}

/**
 * Block-aware keepalive frame: an EMPTY delta matching the current open block — thinking→
 * thinking_delta, text→text_delta, tool_use/server_tool_use→input_json_delta. No open block /
 * redacted_thinking / unknown → fallback {@link ANTHROPIC_PING} (the block-less gap is short-lived;
 * a ping is correct there). All three delta shapes proven to reset CC's 300s idle deadline in
 * exp/cc-idle-280s/REPORT.md.
 */
export function makeAnthropicKeepaliveFrame(openBlock?: OpenBlock): ClientFrame {
  switch (openBlock?.type) {
    case "thinking": {
      return anthropicKeepaliveDelta(openBlock.index, { type: "thinking_delta", thinking: "" })
    }
    case "text": {
      return anthropicKeepaliveDelta(openBlock.index, { type: "text_delta", text: "" })
    }
    case "tool_use":
    case "server_tool_use": {
      return anthropicKeepaliveDelta(openBlock.index, { type: "input_json_delta", partial_json: "" })
    }
    default: {
      return ANTHROPIC_PING
    }
  }
}

/**
 * The keepalive to hand a heartbeat/sink: a block-aware provider (`content_delta` mode) or the
 * fixed ping frame (`ping` mode). Read at stream-start so a hot-reloaded `stream_keepalive_mode`
 * takes effect on new streams.
 */
export function resolveAnthropicKeepalive(mode: "ping" | "content_delta"): ClientFrame | ((openBlock?: OpenBlock) => ClientFrame) {
  return mode === "content_delta" ? makeAnthropicKeepaliveFrame : ANTHROPIC_PING
}
