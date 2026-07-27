import type { StreamEvent } from "~/types/api/anthropic"

/**
 * Return true for an Anthropic content delta whose payload is the empty string.
 *
 * Empty deltas carry no text, thinking, or tool-input bytes for a response rewrite
 * to inspect, but Claude Code counts them as protocol-significant stream chunks.
 * Buffering or suppressing one can therefore trip its 300s event-idle watchdog.
 */
export function isEmptyAnthropicStreamDelta(event: StreamEvent): boolean {
  if (event.type !== "content_block_delta") return false
  const delta = event.delta as { type?: string; text?: string; thinking?: string; partial_json?: string }
  switch (delta.type) {
    case "text_delta": {
      return delta.text === ""
    }
    case "thinking_delta": {
      return delta.thinking === ""
    }
    case "input_json_delta": {
      return delta.partial_json === ""
    }
    default: {
      return false
    }
  }
}
