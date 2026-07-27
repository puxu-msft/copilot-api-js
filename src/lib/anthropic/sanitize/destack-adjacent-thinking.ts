import type {
  //
  ContentBlockParam,
  MessageParam,
} from "~/types/api/anthropic"

export type ThinkingDestackStrategy = "passthrough" | "insert_text" | "move_blocks"

/** Fixed, distinguishable synthetic separator (empty/whitespace text is stripped upstream → useless). */
export const SYNTHETIC_THINKING_SEPARATOR = "[copilot-api: thinking separator]"

export interface DestackStats {
  destackedMessages: number
  insertedMarkers: number
  reorderedBlocks: number
  /** Messages whose LAST block was a thinking block (C2) and had to be re-terminated. */
  terminalRepairs: number
}

const THINKING_TYPES = new Set(["thinking", "redacted_thinking"])
const isThinking = (b: ContentBlockParam): boolean => THINKING_TYPES.has(b.type)

/** A non-thinking block usable as a real separator: text must be trim-non-empty (empty/ws text is stripped). */
function isRealSeparator(b: ContentBlockParam): boolean {
  if (isThinking(b)) return false
  if (b.type === "text") return typeof b.text === "string" && b.text.trim().length > 0
  return true
}

const marker = (): ContentBlockParam => ({ type: "text", text: SYNTHETIC_THINKING_SEPARATOR }) as ContentBlockParam

function hasAdjacentThinking(content: Array<ContentBlockParam>): boolean {
  for (let i = 1; i < content.length; i++) if (isThinking(content[i]) && isThinking(content[i - 1])) return true
  return false
}

/** C2 violation: upstream rejects any assistant message whose FINAL block is thinking. */
function endsWithThinking(content: Array<ContentBlockParam>): boolean {
  const last = content.at(-1)
  return last !== undefined && isThinking(last)
}

/**
 * insert_text: keep all blocks in place; insert a synthetic marker whenever two thinking
 * blocks would be adjacent (C1), plus one at the end when the message would otherwise
 * terminate on thinking (C2).
 *
 * Known boundary: this strategy never MOVES a real block, so a message shaped
 * `[tool_use, thinking]` gets the C2 marker appended AFTER the tool_use, which violates
 * C3. Satisfying C3 requires reordering — that is `move_blocks` (the default). This
 * strategy stays a diagnostic/comparison leg.
 */
function insertTextStrategy(content: Array<ContentBlockParam>, stats: DestackStats): Array<ContentBlockParam> {
  const out: Array<ContentBlockParam> = []
  for (const b of content) {
    const prev = out.at(-1)
    if (prev && isThinking(prev) && isThinking(b)) {
      out.push(marker())
      stats.insertedMarkers++
    }
    out.push(b)
  }
  if (endsWithThinking(out)) {
    out.push(marker())
    stats.insertedMarkers++
  }
  return out
}

/**
 * move_blocks: interleave thinking with real non-thinking blocks (order-preserving) and
 * reserve one non-thinking block to TERMINATE the message; synthetic marker only when
 * there aren't enough real blocks to fill both duties.
 *
 * The terminator is chosen as the LAST `tool_use` when the message has one (C3: a message
 * carrying tool calls must end on `tool_use` — anything after it makes upstream read the
 * turn as an assistant prefill), else the last real separator, else a synthetic marker.
 * Interior `tool_use` blocks are fine as separators (empirically verified).
 */
function moveBlocksStrategy(content: Array<ContentBlockParam>, stats: DestackStats): Array<ContentBlockParam> {
  const thinks = content.filter((b) => isThinking(b))
  const others = content.filter((b) => !isThinking(b))
  const realSeps = others.filter((b) => isRealSeparator(b))
  const nonSepOthers = others.filter((b) => !isRealSeparator(b)) // empty text etc. — never a separator, never a terminator

  // Reserve the terminator BEFORE handing the rest out as separators.
  const lastToolIdx = realSeps.findLastIndex((b) => b.type === "tool_use")
  const tailIdx = lastToolIdx === -1 ? realSeps.length - 1 : lastToolIdx
  let tail: ContentBlockParam
  if (tailIdx >= 0) {
    tail = realSeps[tailIdx]
    realSeps.splice(tailIdx, 1)
  } else {
    tail = marker()
    stats.insertedMarkers++
  }

  const out: Array<ContentBlockParam> = []
  let si = 0
  for (let ti = 0; ti < thinks.length; ti++) {
    out.push(thinks[ti])
    if (ti < thinks.length - 1) {
      if (si < realSeps.length) out.push(realSeps[si++])
      else {
        out.push(marker())
        stats.insertedMarkers++
      }
    }
  }
  // Leftover real separators, then the non-separator others, then the reserved terminator.
  for (; si < realSeps.length; si++) out.push(realSeps[si])
  for (const b of nonSepOthers) out.push(b)
  out.push(tail)
  stats.reorderedBlocks += content.length
  return out
}

/**
 * Enforce the upstream layout constraints on thinking blocks inside assistant messages.
 * Both are hard 400s, empirically confirmed by replaying a rejected production payload
 * (docs/spec/2026-07-26-thinking-terminal-block-layout.md):
 *
 *   C1  two adjacent thinking blocks in the latest assistant message
 *       → "`thinking` ... blocks in the latest assistant message cannot be modified"
 *   C2  an assistant message whose FINAL block is thinking
 *       → "The final block in an assistant message cannot be `thinking`"
 *
 * A third constraint (C3: a message with `tool_use` must END on `tool_use`, or upstream
 * reads it as an assistant prefill) is not repaired here — it is only RESPECTED, so the
 * repair for C1/C2 never manufactures a C3 violation. See `moveBlocksStrategy`.
 *
 * Idempotent: messages already satisfying C1+C2 are returned unchanged (byte-identical).
 * See spec §3.1; runs as the TERMINAL sanitize pass.
 */
export function destackAdjacentThinking(
  messages: Array<MessageParam>,
  strategy: ThinkingDestackStrategy,
): { messages: Array<MessageParam>; stats: DestackStats } {
  const stats: DestackStats = { destackedMessages: 0, insertedMarkers: 0, reorderedBlocks: 0, terminalRepairs: 0 }
  if (strategy === "passthrough") return { messages, stats }

  let changed = false
  const out: Array<MessageParam> = []
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg)
      continue
    }
    const terminalViolation = endsWithThinking(msg.content)
    if (!hasAdjacentThinking(msg.content) && !terminalViolation) {
      out.push(msg)
      continue
    }
    stats.destackedMessages++
    if (terminalViolation) stats.terminalRepairs++
    changed = true
    const newContent = strategy === "insert_text" ? insertTextStrategy(msg.content, stats) : moveBlocksStrategy(msg.content, stats)
    out.push({ ...msg, content: newContent })
  }
  return { messages: changed ? out : messages, stats }
}
