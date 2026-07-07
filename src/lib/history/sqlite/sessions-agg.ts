import type {
  //
  MessageContent,
  SessionSummary,
} from "../types"
import type { Database } from "./connection"

import { getDatabase } from "./connection"
import { getEntryById } from "./read"
import { NOT_ACTIVE } from "./stats"

/**
 * Per-session aggregate view (GROUP BY session_id over terminal entries_v2 rows).
 *
 * Mirrors the `computeStats` aggregate pattern: same `getDatabase()` handle and
 * `NOT_ACTIVE` filter so in-flight (pending/executing/streaming) rows are
 * excluded and counts stay consistent with the terminal lifecycle states.
 *
 * `agentCount` uses `COUNT(DISTINCT agent_id)`, which by SQL semantics ignores
 * NULL — main-agent requests have a NULL agent_id, so a main-agent-only session
 * reports `agentCount = 0` (it counts distinct SUBagents). See `SessionSummary`.
 */
export function querySessionSummaries(limit = 200): Array<SessionSummary> {
  const db = getDatabase()
  const rows = db
    .prepare(
      `SELECT session_id AS sessionId,
              COUNT(*) AS requestCount,
              COUNT(DISTINCT agent_id) AS agentCount,
              COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(cache_read), 0) + COALESCE(SUM(cache_creation), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              MIN(started_at) AS firstStartedAt,
              MAX(started_at) AS lastStartedAt,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status IN ('aborted','interrupted') THEN 1 ELSE 0 END) AS aborted
         FROM entries_v2
        WHERE session_id IS NOT NULL AND ${NOT_ACTIVE}
        GROUP BY session_id
        ORDER BY lastStartedAt DESC
        LIMIT ?`,
    )
    .all(limit) as Array<Omit<SessionSummary, "models" | "preview" | "firstPreview">>

  return rows.map((r) => ({
    ...r,
    models: querySessionModels(db, r.sessionId),
    firstPreview: querySessionUserPreview(db, r.sessionId, "first"),
    preview: querySessionUserPreview(db, r.sessionId, "last"),
  }))
}

/** Distinct non-NULL model names recorded for one session (used to fill `SessionSummary.models`). */
function querySessionModels(db: Database, sessionId: string): Array<string> {
  const rows = db.prepare(`SELECT DISTINCT model FROM entries_v2 WHERE session_id = ? AND model IS NOT NULL AND ${NOT_ACTIVE}`).all(sessionId) as Array<{
    model: string
  }>
  return rows.map((r) => r.model)
}

/**
 * First (or last) real user message of a session's earliest (or latest) terminal entry.
 *
 * The cheap `entries_v2.preview_text` column only summarizes one entry's LAST message
 * (usually a `[tool_result]` or system reminder), so it can't show "what is the user
 * actually discussing". We pick the boundary entry, decode its inbound messages, and
 * scan for the first/last user-role text — stripping `<system-reminder>`/hook noise so
 * the opening intent and the latest follow-up are legible.
 */
function querySessionUserPreview(db: Database, sessionId: string, edge: "first" | "last"): string {
  const order = edge === "first" ? "ASC" : "DESC"
  const row = db.prepare(`SELECT id FROM entries_v2 WHERE session_id = ? AND ${NOT_ACTIVE} ORDER BY started_at ${order} LIMIT 1`).get(sessionId) as {
    id: string
  } | null
  if (!row) return ""
  const entry = getEntryById(row.id)
  const messages = entry?.clientRequest?.messages
  if (!messages || messages.length === 0) return ""
  if (edge === "first") {
    for (const msg of messages) {
      const text = userMessageText(msg)
      if (text) return text
    }
  } else {
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = userMessageText(messages[i])
      if (text) return text
    }
  }
  return ""
}

/** Extract a non-empty user-role text line (system-reminder/hook noise stripped); "" otherwise. */
function userMessageText(msg: MessageContent): string {
  if (msg.role !== "user") return ""
  if (typeof msg.content === "string") return cleanUserText(msg.content)
  if (!Array.isArray(msg.content)) return ""
  const text = msg.content.map((b) => (b && typeof b === "object" && b.type === "text" && typeof b.text === "string" ? b.text : "")).join(" ")
  return cleanUserText(text)
}

/** Strip ALL `<system-reminder>` / `<ide_*>` wrappers (incl. nested) + bare TodoWrite/skill reminders, return first ~100 trimmed chars. */
function cleanUserText(text: string): string {
  let stripped = text
  // Repeat until stable so nested/sequential reminder blocks are fully removed (one pass can leave an outer wrapper around an inner match).
  for (let prev = ""; prev !== stripped; ) {
    prev = stripped
    stripped = stripped.replaceAll(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replaceAll(/<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/g, "")
  }
  // Bare (untagged) injected reminders that arrive as plain text.
  stripped = stripped
    .replaceAll(/The TodoWrite tool hasn't been used[\s\S]*/g, "")
    .replaceAll(/The following skills are available[\s\S]*/g, "")
    .trim()
  return stripped.slice(0, 100)
}
