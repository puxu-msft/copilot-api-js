/**
 * Message mapping utilities for correlating original and rewritten message arrays.
 *
 * Used by both direct Anthropic and translated handlers to track which
 * rewritten messages correspond to which original messages.
 */

import type { AnthropicMessage } from "~/types/api/anthropic"

/**
 * Check if two messages likely correspond to the same original message.
 * Used by buildMessageMapping to handle cases where sanitization removes
 * content blocks within a message (changing its shape) or removes entire messages.
 */
export function messagesMatch(orig: AnthropicMessage, rewritten: AnthropicMessage): boolean {
  if (orig.role !== rewritten.role) return false

  // String content: compare prefix
  if (typeof orig.content === "string" && typeof rewritten.content === "string")
    return (
      rewritten.content.startsWith(orig.content.slice(0, 100))
      || orig.content.startsWith(rewritten.content.slice(0, 100))
    )

  // Array content: compare first block's type and id
  const origBlocks = Array.isArray(orig.content) ? orig.content : []
  const rwBlocks = Array.isArray(rewritten.content) ? rewritten.content : []

  if (origBlocks.length === 0 || rwBlocks.length === 0) return true

  const ob = origBlocks[0]
  const rb = rwBlocks[0]
  if (ob.type !== rb.type) return false
  if (ob.type === "tool_use" && rb.type === "tool_use") return ob.id === rb.id
  if (ob.type === "tool_result" && rb.type === "tool_result") return ob.tool_use_id === rb.tool_use_id
  return true
}

/**
 * Build messageMapping (rwIdx → origIdx) for the direct Anthropic path.
 * Uses a two-pointer approach since rewritten messages maintain the same relative
 * order as originals (all transformations are deletions, never reorderings).
 */
export function buildMessageMapping(
  original: Array<AnthropicMessage>,
  rewritten: Array<AnthropicMessage>,
): Array<number> {
  const mapping: Array<number> = []
  let origIdx = 0

  for (const element of rewritten) {
    while (origIdx < original.length) {
      if (messagesMatch(original[origIdx], element)) {
        mapping.push(origIdx)
        origIdx++
        break
      }
      origIdx++
    }
  }

  // If matching missed some (shouldn't happen), fill with -1
  while (mapping.length < rewritten.length) {
    mapping.push(-1)
  }

  return mapping
}
