/**
 * Block-aware Anthropic keepalive frame builder — the covering matrix proven in
 * exp/cc-idle-280s/REPORT.md. Shared by BOTH the v4 sink path (handler-v4) and the legacy
 * web_search bypass heartbeat (streaming-pump), so it lives here (not in handler-v4) to avoid
 * the handler-v4 → web-search-handler → web-search-direct import cycle.
 *
 * `empty_text` mode injects an EMPTY delta matching the current open block, which resets
 * Claude Code's 300s no-real-content idle deadline that a bare `event: ping` does NOT (a ping is
 * not counted as a "chunk"). `ping` / `enveloped_ping` mode / no open block / redacted_thinking /
 * unknown → bare ping.
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
 * The keepalive to hand a heartbeat/sink: the block-aware provider (`empty_text` mode) or the fixed
 * ping frame (`ping` / `enveloped_ping` modes). Read at stream-start so a hot-reloaded
 * `stream_keepalive_mode` takes effect on new streams. `empty_text` additionally enables the
 * buffered-pre-commit synthetic ANCHOR (empty-text block@0 + empty delta — wired in the sink + driver,
 * NOT here). `enveloped_ping` also injects a synthetic prelude, but ONLY a `message_start` envelope (the
 * envelope-only injector, spec §10.6) — its keepalive is a BARE ping (no anchor block, no empty delta, no
 * index remap), so it resolves to the same fixed {@link ANTHROPIC_PING} as `ping`. The two differ only in
 * whether a message_start envelope is injected (handler-side), not in the heartbeat frame itself.
 */
export function resolveAnthropicKeepalive(mode: "ping" | "enveloped_ping" | "empty_text"): ClientFrame | ((openBlock?: OpenBlock) => ClientFrame) {
  // `ping` + `enveloped_ping` keepalive = a bare ping; `empty_text` = the block-aware empty-delta provider.
  return mode === "ping" || mode === "enveloped_ping" ? ANTHROPIC_PING : makeAnthropicKeepaliveFrame
}
