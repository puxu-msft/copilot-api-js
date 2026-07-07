import type { MessageParam } from "~/types/api/anthropic"

const THINKING_TYPES = new Set(["thinking", "redacted_thinking"])

/**
 * Remove ALL `thinking` / `redacted_thinking` blocks from every assistant
 * message — the blunt remedy shared by the L2 reactive strip-all retry and the
 * L3 proactive quarantine filter.
 *
 * This is deliberately coarser than the block-level protection primitives in
 * `thinking-protection.ts`: instead of preserving signed thinking, it drops it
 * wholesale. Callers use it only on the fallback path where the upstream has
 * already rejected the thinking blocks ("thinking cannot be modified" 400), so
 * echoing them verbatim is no longer possible.
 *
 * Pure and payload-only (no config / state reads). Only `role: "assistant"`
 * messages with array content are touched; string content, user, and system
 * messages pass through untouched. When nothing is stripped the input array is
 * returned by reference (zero-copy, byte-identical) with `strippedCount: 0`.
 */
export function stripAllThinking(messages: Array<MessageParam>): { messages: Array<MessageParam>; strippedCount: number } {
  let strippedCount = 0
  const out = messages.map((msg) => {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg
    const kept = msg.content.filter((block) => !THINKING_TYPES.has(block.type))
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
