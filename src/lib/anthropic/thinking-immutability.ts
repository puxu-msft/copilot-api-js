import type { MessageParam } from "~/types/api/anthropic"

import { state } from "~/lib/state"

/**
 * Whether an assistant message contains signature-bound thinking content.
 *
 * Anthropic returns `thinking` / `redacted_thinking` blocks in assistant
 * messages. These blocks may need stronger preservation guarantees depending
 * on the configured rewrite policy.
 */
export function hasThinkingSignatureBlocks(msg: MessageParam): boolean {
  return (
    msg.role === "assistant"
    && Array.isArray(msg.content)
    && msg.content.some((block) => block.type === "thinking" || block.type === "redacted_thinking")
  )
}

/**
 * Strong preservation mode for assistant messages that contain thinking blocks.
 *
 * When enabled, the entire assistant message is treated as immutable by
 * client-side rewrite passes.
 */
export function isImmutableThinkingAssistantMessage(msg: MessageParam): boolean {
  return state.immutableThinkingMessages && hasThinkingSignatureBlocks(msg)
}
