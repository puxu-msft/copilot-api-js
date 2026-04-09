import type { MessageParam } from "~/types/api/anthropic"

import { state } from "~/lib/state"

/**
 * Whether an assistant message contains signature-bound thinking content.
 *
 * Anthropic returns `thinking` / `redacted_thinking` blocks in assistant
 * messages. These blocks are cryptographically signed and must remain
 * byte-for-byte identical when sent back in subsequent requests.
 */
export function hasThinkingSignatureBlocks(msg: MessageParam): boolean {
  return (
    msg.role === "assistant"
    && Array.isArray(msg.content)
    && msg.content.some((block) => block.type === "thinking" || block.type === "redacted_thinking")
  )
}

/**
 * Whether the entire assistant message should be treated as immutable.
 *
 * Returns true when `thinkingBlockMessagePolicy` is `"immutable"` and the
 * message contains thinking blocks. In this mode, no sanitization, dedup,
 * or truncation pass may alter any block in the message.
 */
export function isImmutableThinkingMessage(msg: MessageParam): boolean {
  return state.thinkingBlockMessagePolicy === "immutable" && hasThinkingSignatureBlocks(msg)
}

/**
 * Whether the assistant message uses fixed-index preservation.
 *
 * In this mode, non-thinking blocks may have their *content* edited (e.g.
 * system-reminder tag removal), but the content array length must not change
 * — empty text blocks are replaced with a single space rather than deleted.
 */
export function isFixedIndexThinkingMessage(msg: MessageParam): boolean {
  return state.thinkingBlockMessagePolicy === "fixed-index" && hasThinkingSignatureBlocks(msg)
}

/**
 * Whether thinking blocks in this message should be preserved (not stripped).
 *
 * Returns true for both `"immutable"` and `"fixed-index"` policies.
 * Only `"stripped"` allows deletion of thinking blocks.
 */
export function shouldPreserveThinkingBlocks(msg: MessageParam): boolean {
  return state.thinkingBlockMessagePolicy !== "stripped" && hasThinkingSignatureBlocks(msg)
}
