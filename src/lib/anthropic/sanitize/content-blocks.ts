import type {
  //
  MessageParam,
  MessagesPayload,
} from "~/types/api/anthropic"

import { isSyntheticReasoningSignature } from "../synthetic-reasoning"

/**
 * Final pass: remove any empty/whitespace-only text content blocks from Anthropic messages.
 * This is a safety net that catches empty blocks regardless of how they were produced.
 */
export function filterEmptyAnthropicTextBlocks(messages: Array<MessageParam>): Array<MessageParam> {
  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg

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
 * Which empty-field combination makes a `type:"thinking"` block a drop target.
 *
 * The name of each mode states **which field being empty triggers the drop** —
 * `text` is the `thinking` plaintext, `signature` is the signed-payload seal:
 *   - `"all_empty"`       — drop only when text AND signature are BOTH empty
 *                           (the double-empty corrupt case; the DEFAULT).
 *   - `"signature_empty"` — drop when signature is empty, regardless of text.
 *   - `"thinking_empty"`  — drop when text is empty, regardless of signature.
 *   - `"any_empty"`       — drop when EITHER text OR signature is empty.
 */
export type ThinkingBlockSanitizeMode = "all_empty" | "signature_empty" | "thinking_empty" | "any_empty"

/**
 * Whether a `type:"thinking"` block should be dropped, given which of its two
 * fields are empty. Each `mode` names WHICH empty field triggers the drop (see
 * {@link ThinkingBlockSanitizeMode}).
 */
function shouldDropThinkingBlock(mode: ThinkingBlockSanitizeMode, textEmpty: boolean, sigEmpty: boolean): boolean {
  switch (mode) {
    case "all_empty": {
      return textEmpty && sigEmpty
    }
    case "signature_empty": {
      return sigEmpty
    }
    case "thinking_empty": {
      return textEmpty
    }
    case "any_empty": {
      return textEmpty || sigEmpty
    }
    default: {
      // Exhaustive over ThinkingBlockSanitizeMode — a new mode must add its case above.
      return ((_never: never) => false)(mode)
    }
  }
}

/**
 * Remove corrupt thinking blocks before sending upstream.
 *
 * The validity of a `type:"thinking"` block is determined by its **signature**,
 * NOT its `thinking` text: a legitimate *encrypted* thinking block has empty
 * `thinking` text but a valid `signature` (the reasoning is carried in the
 * signed payload, not as plaintext). So filtering on empty text alone would
 * wrongly delete valid encrypted thinking and break the signature chain — hence
 * `"thinking_empty"`/`"any_empty"` are aggressive modes to use with care.
 *
 * `mode` names WHICH field being empty triggers the drop (see
 * {@link ThinkingBlockSanitizeMode}):
 *   - `"all_empty"` (default, conservative): remove only **double-empty**
 *     blocks — both `thinking` text AND `signature` empty (e.g. a client echoed
 *     back a `{thinking:"", signature:""}` block after losing the upstream
 *     `signature_delta`). Upstream rejects these with "each thinking block must
 *     contain thinking". Valid encrypted blocks (empty text + real signature)
 *     are kept.
 *   - `"signature_empty"`: remove any thinking block whose `signature` is empty,
 *     regardless of text — these can never pass the upstream signature check.
 *   - `"thinking_empty"`: remove any thinking block whose `thinking` text is
 *     empty, regardless of signature — AGGRESSIVE: this also deletes legitimate
 *     encrypted thinking (empty text + valid signature), so use with care.
 *   - `"any_empty"`: remove a thinking block when EITHER field is empty.
 *
 * Per-block predicate (no `shouldPreserveThinkingBlocks` short-circuit): that
 * guard fires precisely *because* the corrupt block makes
 * `hasThinkingSignatureBlocks` true, so honoring it would make the block
 * unremovable. `redacted_thinking` (carries `data`, no `signature`/`thinking`)
 * is never touched.
 */
export function filterEmptyThinkingBlocks(messages: Array<MessageParam>, mode: ThinkingBlockSanitizeMode): Array<MessageParam> {
  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg

    const filtered = msg.content.filter((block) => {
      if (block.type !== "thinking") return true
      const textEmpty = isThinkingTextEmpty(block)
      const sigEmpty = isThinkingSignatureEmpty(block)
      // `drop` = the mode's empty-field condition; keep = !drop.
      const drop = shouldDropThinkingBlock(mode, textEmpty, sigEmpty)
      return !drop
    })

    if (filtered.length === msg.content.length) return msg
    return { ...msg, content: filtered } as MessageParam
  })
}

/**
 * Strip our SYNTHETIC-reasoning thinking blocks (sentinel-signed forwards of GPT plaintext reasoning)
 * UNCONDITIONALLY — regardless of `thinkingBlockSanitizeCheck`. A client echoes a thinking block back
 * on the next turn; if that turn hits the DIRECT Claude leg, our unforgeable sentinel signature would
 * 400 the upstream ("cannot be modified"). These blocks carry a NON-empty sentinel signature + non-empty
 * text, so `filterEmptyThinkingBlocks` (which drops on EMPTY fields) never catches them — hence a
 * dedicated, always-on strip keyed on the sentinel. See `~/lib/anthropic/synthetic-reasoning`.
 */
export function stripSyntheticReasoningBlocks(messages: Array<MessageParam>): Array<MessageParam> {
  return messages.map((msg) => {
    if (typeof msg.content === "string") return msg
    const filtered = msg.content.filter((block) => !(block.type === "thinking" && isSyntheticReasoningSignature((block as { signature?: unknown }).signature)))
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
