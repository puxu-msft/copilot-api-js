import type {
  //
  MessageParam,
  MessagesPayload,
} from "~/types/api/anthropic"

import { shouldPreserveThinkingBlocks } from "../thinking-immutability"

/**
 * Final pass: remove any empty/whitespace-only text content blocks from Anthropic messages.
 * This is a safety net that catches empty blocks regardless of how they were produced.
 */
export function filterEmptyAnthropicTextBlocks(messages: Array<MessageParam>): Array<MessageParam> {
  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg

    if (msg.role === "assistant" && shouldPreserveThinkingBlocks(msg)) {
      return msg
    }

    const filtered = msg.content.filter((block) => {
      if (block.type === "text" && "text" in block) {
        return block.text.trim() !== ""
      }
      return true
    })

    if (filtered.length === msg.content.length) return msg
    return { ...msg, content: filtered } as MessageParam
  })
}

/**
 * Final pass: remove any empty/whitespace-only text blocks from Anthropic system prompt.
 */
export function filterEmptySystemTextBlocks(system: MessagesPayload["system"]): MessagesPayload["system"] {
  if (!system || typeof system === "string") return system
  return system.filter((block) => block.text.trim() !== "")
}

/** Whether a thinking block's `thinking` text is empty/whitespace-only. */
function isThinkingTextEmpty(block: { thinking?: unknown }): boolean {
  return typeof block.thinking !== "string" || block.thinking.trim() === ""
}

/** Whether a thinking block's `signature` is empty/whitespace-only. */
function isThinkingSignatureEmpty(block: { signature?: unknown }): boolean {
  return typeof block.signature !== "string" || block.signature.trim() === ""
}

/**
 * Remove corrupt thinking blocks before sending upstream.
 *
 * The validity of a `type:"thinking"` block is determined by its **signature**,
 * NOT its `thinking` text: a legitimate *encrypted* thinking block has empty
 * `thinking` text but a valid `signature` (the reasoning is carried in the
 * signed payload, not as plaintext). So filtering on empty text alone would
 * wrongly delete valid encrypted thinking and break the signature chain.
 *
 *   - `"empty_thinking"` (conservative): remove only **double-empty** blocks —
 *     both `thinking` text AND `signature` empty (e.g. a client echoed back a
 *     `{thinking:"", signature:""}` block after losing the upstream
 *     `signature_delta`). Upstream rejects these with "each thinking block must
 *     contain thinking". Valid encrypted blocks (empty text + real signature)
 *     are kept.
 *   - `"empty_any"` (aggressive): remove any thinking block whose `signature` is
 *     empty, regardless of text — these can never pass the upstream signature
 *     check anyway.
 *
 * Per-block predicate (no `shouldPreserveThinkingBlocks` short-circuit): that
 * guard fires precisely *because* the corrupt block makes
 * `hasThinkingSignatureBlocks` true, so honoring it would make the block
 * unremovable. `redacted_thinking` (carries `data`, no `signature`/`thinking`)
 * is never touched.
 */
export function filterEmptyThinkingBlocks(messages: Array<MessageParam>, mode: "empty_thinking" | "empty_any"): Array<MessageParam> {
  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg

    const filtered = msg.content.filter((block) => {
      if (block.type !== "thinking") return true
      const sigEmpty = isThinkingSignatureEmpty(block)
      // empty_any: drop any unsigned thinking block. empty_thinking: only when
      // text is ALSO empty (the double-empty corrupt case).
      return mode === "empty_any" ? !sigEmpty : !sigEmpty || !isThinkingTextEmpty(block)
    })

    if (filtered.length === msg.content.length) return msg
    return { ...msg, content: filtered } as MessageParam
  })
}

/**
 * Count total content blocks in Anthropic messages.
 */
export function countAnthropicContentBlocks(messages: Array<MessageParam>): number {
  let count = 0
  for (const msg of messages) {
    count += typeof msg.content === "string" ? 1 : msg.content.length
  }
  return count
}
