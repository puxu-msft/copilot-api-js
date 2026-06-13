/**
 * Message mapping utilities for correlating original and rewritten message arrays.
 *
 * Used by Anthropic handlers to track which rewritten messages correspond
 * to which original messages.
 */

import type { MessageParam } from "~/types/api/anthropic"

/**
 * Check if two messages likely correspond to the same original message.
 * Used by buildMessageMapping to handle cases where sanitization removes
 * content blocks within a message (changing its shape) or removes entire messages.
 */
export function messagesMatch(orig: MessageParam, rewritten: MessageParam): boolean {
  if (orig.role !== rewritten.role) return false

  // String content: compare prefix
  if (typeof orig.content === "string" && typeof rewritten.content === "string")
    return rewritten.content.startsWith(orig.content.slice(0, 100)) || orig.content.startsWith(rewritten.content.slice(0, 100))

  // Array content: compare first block's type and id
  const origBlocks = Array.isArray(orig.content) ? orig.content : []
  const rwBlocks = Array.isArray(rewritten.content) ? rewritten.content : []

  if (origBlocks.length === 0 || rwBlocks.length === 0) return true

  const ob = origBlocks[0]
  const rb = rwBlocks[0]

  // A downgraded server_tool_use (rewriteServerToolHistory turns server_tool_use
  // → tool_use) must still match its original assistant message by id.
  const obToolUse = ob.type === "tool_use" || ob.type === "server_tool_use"
  const rbToolUse = rb.type === "tool_use" || rb.type === "server_tool_use"
  if (obToolUse && rbToolUse) return (ob as { id?: string }).id === (rb as { id?: string }).id

  if (ob.type !== rb.type) return false
  if (ob.type === "tool_result" && rb.type === "tool_result") return ob.tool_use_id === rb.tool_use_id
  return true
}

/**
 * Build messageMapping (rwIdx → origIdx) for the direct Anthropic path.
 *
 * Two-pointer walk: most transformations are deletions (rewritten ⊆ original,
 * same relative order), so a rewritten message matches the next original at or
 * after the current cursor; skipped originals were deleted.
 *
 * Insertions are also supported: `rewriteServerToolHistory` splits one original
 * assistant turn (server_tool_use + result + text) into TWO rewritten messages
 * (assistant tool_use+text, then a new user tool_result). The split-out message
 * has no original of its own, so it maps to the LAST matched original index
 * (the source turn it was derived from) rather than -1.
 */
export function buildMessageMapping(original: Array<MessageParam>, rewritten: Array<MessageParam>): Array<number> {
  const mapping: Array<number> = []
  let origIdx = 0
  let lastMatched = -1

  for (const element of rewritten) {
    // Scan forward for a match WITHOUT consuming originals on failure, so an
    // inserted (split-out) message doesn't burn through the remaining originals.
    let found = -1
    for (let scan = origIdx; scan < original.length; scan++) {
      if (messagesMatch(original[scan], element)) {
        found = scan
        break
      }
    }

    if (found >= 0) {
      mapping.push(found)
      lastMatched = found
      origIdx = found + 1
    } else {
      // No original ahead matches — an inserted message derived from the last
      // matched original turn (e.g. the user tool_result split off an assistant).
      mapping.push(lastMatched)
    }
  }

  return mapping
}
