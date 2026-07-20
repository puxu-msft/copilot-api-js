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

/** insert_text: keep all blocks in place; insert a synthetic marker whenever two thinking blocks would be adjacent. */
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
  return out
}

/** move_blocks: interleave thinking with real non-thinking blocks (order-preserving); synthetic marker only when insufficient. */
function moveBlocksStrategy(content: Array<ContentBlockParam>, stats: DestackStats): Array<ContentBlockParam> {
  const thinks = content.filter((b) => isThinking(b))
  const others = content.filter((b) => !isThinking(b))
  const realSeps = others.filter((b) => isRealSeparator(b))
  const nonSepOthers = others.filter((b) => !isRealSeparator(b)) // empty text etc. — appended, never used as separator
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
  // append leftover real separators + all non-separator others, preserving order
  for (; si < realSeps.length; si++) out.push(realSeps[si])
  for (const b of nonSepOthers) out.push(b)
  stats.reorderedBlocks += content.length
  return out
}

/**
 * De-stack adjacent thinking/redacted_thinking blocks so no two are adjacent in any assistant message.
 * Idempotent: messages without adjacent thinking are returned unchanged (byte-identical).
 * See spec §3.1; runs as the TERMINAL sanitize pass.
 */
export function destackAdjacentThinking(
  messages: Array<MessageParam>,
  strategy: ThinkingDestackStrategy,
): { messages: Array<MessageParam>; stats: DestackStats } {
  const stats: DestackStats = { destackedMessages: 0, insertedMarkers: 0, reorderedBlocks: 0 }
  if (strategy === "passthrough") return { messages, stats }

  let changed = false
  const out: Array<MessageParam> = []
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg)
      continue
    }
    if (!hasAdjacentThinking(msg.content)) {
      out.push(msg)
      continue
    }
    stats.destackedMessages++
    changed = true
    const newContent = strategy === "insert_text" ? insertTextStrategy(msg.content, stats) : moveBlocksStrategy(msg.content, stats)
    out.push({ ...msg, content: newContent })
  }
  return { messages: changed ? out : messages, stats }
}
