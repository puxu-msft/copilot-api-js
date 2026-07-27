import type {
  //
  ContentBlockParam,
  MessageParam,
} from "~/types/api/anthropic"

export type AssistantBlockLayoutStrategy = "passthrough" | "move_blocks"

/**
 * Synthetic separator sentinel — a VERSIONED FAMILY matched by prefix, not one frozen literal.
 *
 * Why a text block at all: the separator must survive the round trip through upstream AND through
 * the client's stored history, so it can only be an ordinary, upstream-legal content block. Empty or
 * whitespace-only text is stripped upstream, so it must carry real characters. That means the TEXT
 * ITSELF is the only identity we get — an in-process tag (Symbol/WeakSet) cannot survive a client
 * replaying the block back at us in the next turn, which is exactly when we need to recognise it.
 *
 * Why prefix + version rather than a single frozen string: the previous design compared with `===`
 * against one literal, so changing the wording would silently strand every marker already baked into
 * a client's history (they would stop being recognised as orphans and leak upstream as stray text).
 * Matching a `[copilot-api:thinking-separator…` prefix means a future revision only has to bump the
 * version, and {@link LEGACY_SYNTHETIC_SEPARATORS} keeps older spellings recognised until no live
 * conversation carries them.
 *
 * One producer ({@link makeSyntheticSeparator}) and one recogniser ({@link isSyntheticThinkingSeparator});
 * `tests/anthropic/synthetic-separator-identity.unit.test.ts` fails the build if any other module
 * compares against the literal directly.
 */
const SYNTHETIC_SEPARATOR_PREFIX = "[copilot-api:thinking-separator"

/** The separator this build EMITS. Consumers must recognise via {@link isSyntheticThinkingSeparator}. */
export const SYNTHETIC_THINKING_SEPARATOR = `${SYNTHETIC_SEPARATOR_PREFIX}:v1]`

/**
 * Spellings emitted by earlier builds and still present in live client histories. Drop an entry only
 * once no client can replay it (they are conversation-lifetime, not persisted-history, artefacts).
 * `[copilot-api: thinking separator]` was the only spelling before 2026-07-27.
 */
const LEGACY_SYNTHETIC_SEPARATORS: ReadonlySet<string> = new Set(["[copilot-api: thinking separator]"])

/** Is this block one of OUR synthetic separators — including one a client replayed from an older build? */
export function isSyntheticThinkingSeparator(block: ContentBlockParam): boolean {
  if (block.type !== "text" || typeof block.text !== "string") return false
  const text = block.text.trim()
  return text.startsWith(SYNTHETIC_SEPARATOR_PREFIX) || LEGACY_SYNTHETIC_SEPARATORS.has(text)
}

/** Build a fresh synthetic separator block (the single producer). */
export function makeSyntheticSeparator(): ContentBlockParam {
  return { type: "text", text: SYNTHETIC_THINKING_SEPARATOR } as ContentBlockParam
}

export interface BlockLayoutRepairStats {
  repairedMessages: number
  insertedMarkers: number
  reorderedBlocks: number
  /** Messages whose LAST block was a thinking block (C2) and had to be re-terminated. */
  terminalRepairs: number
  /** Messages carrying `tool_use` that did not END on it (C3) and had to be re-terminated. */
  toolTerminalRepairs: number
}

const THINKING_TYPES = new Set(["thinking", "redacted_thinking"])
const isThinking = (b: ContentBlockParam): boolean => THINKING_TYPES.has(b.type)

/** A non-thinking block usable as a real separator: text must be trim-non-empty (empty/ws text is stripped). */
function isRealSeparator(b: ContentBlockParam): boolean {
  if (isThinking(b)) return false
  if (b.type === "text") return typeof b.text === "string" && b.text.trim().length > 0
  return true
}

const marker = makeSyntheticSeparator

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
 * C3 violation: upstream rejects an assistant message that carries `tool_use` but does not
 * END on one — anything after the tool call makes it read the turn as an assistant prefill
 * ("This model does not support assistant message prefill. The conversation must end with a
 * user message." — misleading wording, empirically pinned to this shape; spec §2 C3).
 */
function violatesToolTerminal(content: Array<ContentBlockParam>): boolean {
  return content.some((b) => b.type === "tool_use") && content.at(-1)?.type !== "tool_use"
}

/**
 * Does ANY assistant message violate C3? The L2 reactive fallback composes this with the
 * ACTUAL `stripAllThinking` output (before vs after) to decide whether strip-all cures a
 * C3/prefill 400 — never with a re-implemented approximation of that remedy, which would
 * drift (strip-all also drops orphaned {@link SYNTHETIC_THINKING_SEPARATOR} markers, so a
 * hand-rolled "filter out thinking" predicate mis-answers `[tool, T, SEP]`).
 */
export function hasToolTerminalViolation(messages: Array<MessageParam>): boolean {
  return messages.some((msg) => msg.role === "assistant" && Array.isArray(msg.content) && violatesToolTerminal(msg.content))
}

/**
 * Does the conversation end on an assistant turn — the LITERAL assistant prefill named by
 * C3's misleading wording ("The conversation must end with a user message.")? That shape is
 * NOT curable by stripping thinking, so L2 must not spend its one-shot retry on it.
 *
 * A trailing `role: "system"` message is NOT a prefill: inline system messages are forwarded
 * as-is for models that accept them, and such turns are empirically answered (the incident
 * conversation req_1785160010003_3754 had five prior turns ending on a system message, each
 * of which upstream answered normally). Only `assistant` counts.
 */
export function endsOnAssistantTurn(messages: Array<MessageParam>): boolean {
  return messages.at(-1)?.role === "assistant"
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
function moveBlocksStrategy(content: Array<ContentBlockParam>, stats: BlockLayoutRepairStats): Array<ContentBlockParam> {
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
 * All three are hard 400s, empirically confirmed by replaying rejected production payloads
 * (docs/spec/2026-07-26-thinking-terminal-block-layout.md):
 *
 *   C1  two adjacent thinking blocks in the latest assistant message
 *       → "`thinking` ... blocks in the latest assistant message cannot be modified"
 *   C2  an assistant message whose FINAL block is thinking
 *       → "The final block in an assistant message cannot be `thinking`"
 *   C3  an assistant message carrying `tool_use` that does not END on it
 *       → "This model does not support assistant message prefill. The conversation must end
 *          with a user message." (wording is misleading — see `violatesToolTerminal`)
 *
 * `move_blocks` REPAIRS all three: it reserves the last `tool_use` as terminator so a C1/C2 repair
 * can never manufacture C3, and since 2026-07-27 a standalone C3 violation (client-native, or one
 * another rewrite pass introduced) is a trigger in its own right. `passthrough` repairs nothing —
 * it exists so upstream probes can put an exact arrangement on the wire.
 *
 * Idempotent: messages already satisfying C1+C2+C3 are returned unchanged (byte-identical).
 * See spec §3.1; runs as the TERMINAL sanitize pass.
 */
export function repairAssistantBlockLayout(
  messages: Array<MessageParam>,
  strategy: AssistantBlockLayoutStrategy,
): { messages: Array<MessageParam>; stats: BlockLayoutRepairStats } {
  const stats: BlockLayoutRepairStats = { repairedMessages: 0, insertedMarkers: 0, reorderedBlocks: 0, terminalRepairs: 0, toolTerminalRepairs: 0 }
  if (strategy === "passthrough") return { messages, stats }

  let changed = false
  const out: Array<MessageParam> = []
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg)
      continue
    }
    const terminalViolation = endsWithThinking(msg.content)
    const toolTerminalViolation = violatesToolTerminal(msg.content)
    if (!hasAdjacentThinking(msg.content) && !terminalViolation && !toolTerminalViolation) {
      out.push(msg)
      continue
    }
    stats.repairedMessages++
    if (terminalViolation) stats.terminalRepairs++
    if (toolTerminalViolation) stats.toolTerminalRepairs++
    changed = true
    const newContent = moveBlocksStrategy(msg.content, stats)
    out.push({ ...msg, content: newContent })
  }
  return { messages: changed ? out : messages, stats }
}
