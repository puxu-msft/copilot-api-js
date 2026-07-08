import type {
  //
  ContentBlockParam,
  MessageParam,
} from "~/types/api/anthropic"

import { SYNTHETIC_THINKING_SEPARATOR } from "~/lib/anthropic/sanitize/destack-adjacent-thinking"

const THINKING_TYPES = new Set(["thinking", "redacted_thinking"])

/**
 * A block that {@link stripAllThinking} removes: any `thinking` /
 * `redacted_thinking` block, PLUS an orphaned synthetic de-stack separator. L1
 * de-stack ({@link destackAdjacentThinking}, `insert_text` / `move_blocks`)
 * inserts a fixed {@link SYNTHETIC_THINKING_SEPARATOR} text block between two
 * thinking blocks; once strip-all removes the thinking blocks it separated, that
 * marker is a meaningless orphan that would otherwise leak upstream — so we drop
 * it in the same pass.
 */
function isStrippableBlock(block: ContentBlockParam): boolean {
  if (THINKING_TYPES.has(block.type)) return true
  return block.type === "text" && block.text === SYNTHETIC_THINKING_SEPARATOR
}

/**
 * Remove ALL `thinking` / `redacted_thinking` blocks — plus any orphaned
 * synthetic de-stack separator ({@link SYNTHETIC_THINKING_SEPARATOR}) they left
 * behind — from every assistant message. The blunt remedy shared by the L2
 * reactive strip-all retry and the L3 proactive quarantine filter.
 *
 * This is deliberately coarser than the block-level protection primitives in
 * `thinking-protection.ts`: instead of preserving signed thinking, it drops it
 * wholesale. Callers use it only on the fallback path where the upstream has
 * already rejected the thinking blocks ("thinking cannot be modified" 400), so
 * echoing them verbatim is no longer possible. On such a learning turn L1
 * de-stack may already have inserted a synthetic separator between two thinking
 * blocks; stripping the thinking without also dropping that marker would orphan
 * it and leak it upstream, so strip-all removes it too.
 *
 * `strippedCount` counts EVERY block removed — thinking/redacted_thinking AND
 * orphaned synthetic separators — so `strippedCount > 0` iff the array actually
 * changed. Callers gate on `strippedCount === 0` to decide "did anything change /
 * should we retry" (the L3 proactive filter even derives its `changed` flag from
 * it), so counting a dropped marker here is what makes marker removal observable
 * to them.
 *
 * Pure and payload-only (no config / state reads). Only `role: "assistant"`
 * messages with array content are touched; string content, user, and system
 * messages pass through untouched. When nothing is removed the input array is
 * returned by reference (zero-copy, byte-identical) with `strippedCount: 0`.
 */
export function stripAllThinking(messages: Array<MessageParam>): { messages: Array<MessageParam>; strippedCount: number } {
  let strippedCount = 0
  const out = messages.map((msg) => {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg
    const kept = msg.content.filter((block) => !isStrippableBlock(block))
    const removed = msg.content.length - kept.length
    if (removed === 0) return msg
    strippedCount += removed
    return { ...msg, content: kept }
  })
  // Zero-copy on no-op: keep the same array reference when no message was
  // rewritten. Decide by reference-comparing the mapped output against the
  // input rather than a closure-mutated `changed` flag — TS control-flow
  // analysis doesn't propagate closure writes back to the outer scope, so such
  // a flag reads as statically `false` (trips no-unnecessary-condition).
  const changed = out.some((msg, index) => msg !== messages[index])
  return { messages: changed ? out : messages, strippedCount }
}
