import type { SessionSummary } from "../types"
import type { Database } from "./connection"

import { getDatabase } from "./connection"
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
              COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              MIN(started_at) AS firstStartedAt,
              MAX(started_at) AS lastStartedAt,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed
         FROM entries_v2
        WHERE session_id IS NOT NULL AND ${NOT_ACTIVE}
        GROUP BY session_id
        ORDER BY lastStartedAt DESC
        LIMIT ?`,
    )
    .all(limit) as Array<Omit<SessionSummary, "models" | "preview">>

  return rows.map((r) => ({ ...r, models: querySessionModels(db, r.sessionId), preview: querySessionLastPreview(db, r.sessionId) }))
}

/** Distinct non-NULL model names recorded for one session (used to fill `SessionSummary.models`). */
function querySessionModels(db: Database, sessionId: string): Array<string> {
  const rows = db.prepare(`SELECT DISTINCT model FROM entries_v2 WHERE session_id = ? AND model IS NOT NULL AND ${NOT_ACTIVE}`).all(sessionId) as Array<{
    model: string
  }>
  return rows.map((r) => r.model)
}

/** Preview text of the latest (max started_at) terminal entry in one session (fills `SessionSummary.preview`). */
function querySessionLastPreview(db: Database, sessionId: string): string {
  const row = db.prepare(`SELECT preview_text FROM entries_v2 WHERE session_id = ? AND ${NOT_ACTIVE} ORDER BY started_at DESC LIMIT 1`).get(sessionId) as {
    preview_text: string | null
  } | null
  return row?.preview_text ?? ""
}
