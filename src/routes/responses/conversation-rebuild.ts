/**
 * Reconstruct CC-shaped conversation history from a stored Responses session.
 *
 * Codex CLI and similar Responses clients chain turns via `previous_response_id`,
 * relying on the proxy to maintain server-side conversation state. When the
 * proxy falls back to stateless /chat/completions upstream, it must replay
 * the prior conversation manually — this module performs that reconstruction.
 *
 * The transform uses a "turn increment" extraction:
 * for each historical entry, take the trailing run of non-assistant messages
 * (the "new turn" the client added) plus that entry's response. This is
 * correct for both Codex's delta mode (each turn carries only the new input)
 * and the rarer full-history mode (each turn echoes prior history) — the
 * suffix walk dedupes the latter automatically.
 */

import consola from "consola"

import type {
  //
  HistoryEntry,
  MessageContent,
} from "~/lib/history"
import type {
  //
  ContentPart,
  Message,
} from "~/types/api/openai-chat-completions"

import { getSessionEntries } from "~/lib/history"

/**
 * Cap entries we replay — bounds context for very long sessions. 50 turns at
 * ~2KB each ≈ 100KB, comfortably under typical CC context budgets once
 * instructions + tools land on top.
 */
const MAX_REPLAY_ENTRIES = 50

/** Overscan to compensate for entries filtered out (failed / wrong endpoint). */
const REPLAY_QUERY_BUFFER = 20

/**
 * Markers `responsesInputToMessages` stores for non-message Responses items
 * (item_reference, reasoning, compaction) — informational placeholders, not
 * real assistant turns. Recognized by the `[type: id]` shape.
 */
const MARKER_PATTERN = /^\[\w+:\s.+\]$/

/**
 * Reconstruct prior conversation as a flat CC Message[] suitable for
 * prepending to a fresh translated payload. Returns [] when there's no
 * session, the session is unknown, or no replayable entries exist.
 */
export function rebuildConversationMessages(sessionId: string | undefined): Array<Message> {
  if (!sessionId) return []

  // Overscan: filter may drop entries; load enough to fill MAX_REPLAY_ENTRIES
  // after filtering out non-Responses / failed entries.
  const session = getSessionEntries(sessionId, { limit: MAX_REPLAY_ENTRIES + REPLAY_QUERY_BUFFER })
  return rebuildMessagesFromEntries(session.entries, sessionId)
}

/**
 * Pure core of conversation rebuild: filter the stored entries down to
 * replayable Responses turns, cap by recency, and flatten into CC messages.
 * Separated from `rebuildConversationMessages` (which adds the history fetch)
 * so the transformation logic is testable with controlled entry lists.
 */
export function rebuildMessagesFromEntries(entries: Array<HistoryEntry>, sessionId?: string): Array<Message> {
  if (entries.length === 0) return []

  const replayable = entries.filter((entry) => isReplayableEntry(entry))
  const capped = replayable.slice(-MAX_REPLAY_ENTRIES)

  if (capped.length === 0) {
    consola.debug(`[responses-fallback] session ${sessionId ?? "?"} has no replayable entries`)
    return []
  }

  const messages: Array<Message> = []
  for (const entry of capped) {
    const turnIncrement = extractTurnIncrement(entry.clientRequest?.messages ?? [])
    for (const stored of turnIncrement) messages.push(toCCMessage(stored))
    const upstreamBody = entry.attempts?.at(-1)?.upstreamResponse?.body
    if (upstreamBody) {
      messages.push(toCCMessage(upstreamBody))
    }
  }
  return messages
}

/**
 * Only replay successfully completed Responses-format turns. Failed/in-flight
 * entries and entries from other endpoints (Anthropic, plain CC) would
 * corrupt the conversation shape.
 */
function isReplayableEntry(entry: HistoryEntry): boolean {
  return entry.endpoint === "openai-responses" && entry.state === "completed" && entry.attempts?.at(-1)?.upstreamResponse?.success !== false
}

/**
 * Extract the trailing run of non-assistant messages (the client's new input
 * for that turn). Skips system/developer prelude (those are static session
 * setup) and skips marker placeholders that `responsesInputToMessages`
 * synthesizes for reasoning/item_reference items.
 */
function extractTurnIncrement(stored: Array<MessageContent>): Array<MessageContent> {
  const nonPrelude = stored.filter((m) => m.role !== "system" && m.role !== "developer")
  const suffix: Array<MessageContent> = []
  for (let i = nonPrelude.length - 1; i >= 0; i--) {
    const msg = nonPrelude[i]
    if (msg.role === "assistant") {
      // Marker assistant strings (e.g. "[reasoning: id_x]") aren't real
      // assistant turns — skip them and keep walking back.
      if (typeof msg.content === "string" && MARKER_PATTERN.test(msg.content)) continue
      break
    }
    suffix.unshift(msg)
  }
  return suffix
}

/**
 * Stored MessageContent is already CC-flavored (see responses-conversion.ts —
 * tool_calls are lifted to top-level, role:"tool" is used for results). The
 * only block-level conversion needed is image: Anthropic stored shape
 * `{type:"image", source:{type:"url", url}}` → CC `{type:"image_url", ...}`.
 */
function toCCMessage(stored: MessageContent): Message {
  return {
    role: stored.role as Message["role"],
    content: normalizeContent(stored.content),
    ...(stored.tool_calls && {
      tool_calls: stored.tool_calls.map((t) => ({
        id: t.id,
        type: "function" as const,
        function: t.function,
      })),
    }),
    ...(stored.tool_call_id !== undefined && { tool_call_id: stored.tool_call_id }),
    ...(stored.name !== undefined && { name: stored.name }),
  }
}

function normalizeContent(content: MessageContent["content"]): string | Array<ContentPart> | null {
  if (content === null) return null
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return null

  const parts: Array<ContentPart> = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const b = block as Record<string, unknown>
    if (b.type === "text" && typeof b.text === "string") {
      parts.push({ type: "text", text: b.text })
      continue
    }
    if (b.type === "image") {
      // Anthropic-shaped: { source: { type: "url", url } } → CC image_url part.
      const src = b.source as { type?: string; url?: string } | undefined
      if (src?.url) parts.push({ type: "image_url", image_url: { url: src.url } })
      continue
    }
    // tool_use / tool_result / thinking blocks are split into separate
    // messages at the role-extraction layer (see responses-conversion.ts);
    // embedding them inside content here would be malformed CC. Drop silently.
  }

  // Empty content array becomes empty string — CC requires non-null content
  // for non-tool messages and an empty array is invalid in some implementations.
  return parts.length > 0 ? parts : ""
}
