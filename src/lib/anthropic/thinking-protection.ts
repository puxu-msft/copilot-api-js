/**
 * Thinking-block protection primitives.
 *
 * Anthropic returns `thinking` / `redacted_thinking` blocks in assistant messages.
 * Their `signature` is **self-contained** — it encrypts the thinking content itself
 * (the upstream decrypts and rebuilds it) and does NOT bind to surrounding context or
 * array position (empirically verified against opus-4.8 via the live backend). The only
 * real constraints are: thinking blocks must be echoed **verbatim**, and consecutive
 * thinking sequences must not be **reordered**.
 *
 * Protection is therefore **block-level**, not message-level: passes may freely clean up
 * around thinking blocks (drop orphan tools, downgrade server tools, edit/drop non-thinking
 * blocks) as long as they don't mutate, drop, or reorder the thinking blocks themselves.
 * The two predicates below gate the passes that WOULD reorder/delete thinking (merge and
 * strip); they key on thinking *existence*, which is all that matters.
 */

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
  return msg.role === "assistant" && Array.isArray(msg.content) && msg.content.some((block) => block.type === "thinking" || block.type === "redacted_thinking")
}

/**
 * Whether thinking blocks in this message should be preserved (not stripped).
 *
 * True under the `"preserve"` policy when the message contains thinking blocks.
 * Only `"stripped"` allows deletion/reordering of thinking blocks. Used by the
 * merge passes (dedup / system-messages adjacency merge) and the strip pass to
 * avoid reordering or removing signed thinking.
 */
export function shouldPreserveThinkingBlocks(msg: MessageParam): boolean {
  return state.thinkingBlockMessagePolicy !== "stripped" && hasThinkingSignatureBlocks(msg)
}
