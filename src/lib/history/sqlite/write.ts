import type {
  //
  HistoryEntry,
  Session,
} from "~/lib/history/types"

import { getDatabase } from "./connection"
import { serializeEntry } from "./serialize"

const INSERT_ENTRY_SQL = `
INSERT OR REPLACE INTO entries (
  id, session_id, started_at, ended_at, duration_ms,
  model, endpoint, transport, status,
  input_tokens, output_tokens, cache_read, cache_creation, reasoning_tokens,
  stop_reason, error_message,
  message_count, preview_text, search_text,
  blob_gz
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`

/**
 * Insert (or upsert by id) one entry and refresh its session aggregate row.
 *
 * Concurrency / re-insert safety:
 *   The entries table uses `INSERT OR REPLACE`, so calling `insertCompletedEntry`
 *   twice with the same entry.id is benign for entries themselves (the old row
 *   is replaced). For the sessions table, however, the previous design used
 *   incremental upsert (`request_count = request_count + 1`,
 *   `total_input_tokens = total_input_tokens + excluded.total_input_tokens`),
 *   which double-counts on the second call. Because incremental aggregates
 *   are not recoverable once corrupted (`/api/status` and history dashboards
 *   surface them), this function now recomputes the per-session aggregates
 *   from the canonical entries table inside the same transaction. The cost
 *   is one extra indexed SELECT per insert; the win is unconditional
 *   correctness under any future code path that may re-insert.
 */
const UPSERT_SESSION_SQL = `
INSERT INTO sessions (
  id, start_time, last_activity, request_count,
  total_input_tokens, total_output_tokens,
  models_json, endpoints_json, tools_used_json
) VALUES (?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  last_activity = excluded.last_activity,
  request_count = excluded.request_count,
  total_input_tokens = excluded.total_input_tokens,
  total_output_tokens = excluded.total_output_tokens,
  models_json = excluded.models_json,
  endpoints_json = excluded.endpoints_json,
  tools_used_json = excluded.tools_used_json
`

const RECOMPUTE_SESSION_AGGREGATES_SQL = `
SELECT
  COUNT(*) AS request_count,
  COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
  COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
  MIN(started_at) AS start_time,
  COALESCE(MAX(ended_at), MAX(started_at)) AS last_activity
FROM entries
WHERE session_id = ?
`

/**
 * Distinct model / endpoint set used across all entries in the session.
 * `models_json` and `endpoints_json` are not numeric — they need their own
 * recompute query because GROUP_CONCAT(DISTINCT) does not coexist with the
 * scalar aggregates above in a single non-GROUP-BY SELECT in SQLite.
 */
const RECOMPUTE_SESSION_MODELS_SQL = `
SELECT DISTINCT model FROM entries WHERE session_id = ? AND model IS NOT NULL ORDER BY model
`
const RECOMPUTE_SESSION_ENDPOINTS_SQL = `
SELECT DISTINCT endpoint FROM entries WHERE session_id = ? AND endpoint IS NOT NULL ORDER BY endpoint
`

export function insertCompletedEntry(entry: HistoryEntry): void {
  const db = getDatabase()
  const { row } = serializeEntry(entry)

  const tx = db.transaction(() => {
    db.prepare(INSERT_ENTRY_SQL).run(
      row.id,
      row.session_id,
      row.started_at,
      row.ended_at,
      row.duration_ms,
      row.model,
      row.endpoint,
      row.transport,
      row.status,
      row.input_tokens,
      row.output_tokens,
      row.cache_read,
      row.cache_creation,
      row.reasoning_tokens,
      row.stop_reason,
      row.error_message,
      row.message_count,
      row.preview_text,
      row.search_text,
      row.blob_gz,
    )

    if (row.session_id) {
      // Recompute session aggregates from the entries table — this is the
      // single source of truth. Avoids the double-count failure mode that
      // would arise if a future code path called insertCompletedEntry twice
      // for the same id (entries row would just be replaced; sessions would
      // tick request_count + tokens again under incremental upsert).
      const agg = db.prepare(RECOMPUTE_SESSION_AGGREGATES_SQL).get(row.session_id) as {
        request_count: number
        total_input_tokens: number
        total_output_tokens: number
        start_time: number
        last_activity: number
      } | null
      if (agg && agg.request_count > 0) {
        // Recompute distinct model / endpoint sets. Previously sessions.models_json
        // was a single-element array of the latest entry's model, silently dropping
        // historical models for a session that touched multiple — that broke any
        // downstream UI that filtered or counted sessions by model diversity.
        const modelRows = db.prepare(RECOMPUTE_SESSION_MODELS_SQL).all(row.session_id) as Array<{
          model: string | null
        }>
        const endpointRows = db.prepare(RECOMPUTE_SESSION_ENDPOINTS_SQL).all(row.session_id) as Array<{
          endpoint: string | null
        }>
        const models = modelRows.map((r) => r.model).filter((m): m is string => typeof m === "string" && m.length > 0)
        const endpoints = endpointRows.map((r) => r.endpoint).filter((e): e is string => typeof e === "string" && e.length > 0)

        // Preserve any tools_used_json the session already had — recompute only
        // covers entries-derivable aggregates; tools_used is set out-of-band
        // via upsertSessionMeta and must not be silently nulled on every insert.
        const existing = db.prepare("SELECT tools_used_json FROM sessions WHERE id = ?").get(row.session_id) as { tools_used_json: string | null } | undefined
        const toolsUsedJson = existing?.tools_used_json ?? null

        db.prepare(UPSERT_SESSION_SQL).run(
          row.session_id,
          agg.start_time,
          agg.last_activity,
          agg.request_count,
          agg.total_input_tokens,
          agg.total_output_tokens,
          JSON.stringify(models),
          JSON.stringify(endpoints),
          toolsUsedJson,
        )
      }
    }
  })
  tx()
}

export function deleteSession(sessionId: string): number {
  const db = getDatabase()
  let deleted = 0
  const tx = db.transaction(() => {
    const r = db.prepare("DELETE FROM entries WHERE session_id = ?").run(sessionId)
    deleted = r.changes
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId)
  })
  tx()
  return deleted
}

export function clearAllEntries(): void {
  const db = getDatabase()
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM entries").run()
    db.prepare("DELETE FROM sessions").run()
    db.prepare("DELETE FROM response_sessions").run()
  })
  tx()
}

export function upsertResponseSession(responseId: string, sessionId: string): void {
  getDatabase().prepare("INSERT OR REPLACE INTO response_sessions (response_id, session_id) VALUES (?, ?)").run(responseId, sessionId)
}

export function upsertSessionMeta(session: Session): void {
  getDatabase()
    .prepare(
      `INSERT INTO sessions (
        id, start_time, last_activity, request_count,
        total_input_tokens, total_output_tokens,
        models_json, endpoints_json, tools_used_json
      ) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        last_activity = excluded.last_activity,
        request_count = excluded.request_count,
        total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens,
        models_json = excluded.models_json,
        endpoints_json = excluded.endpoints_json,
        tools_used_json = excluded.tools_used_json`,
    )
    .run(
      session.id,
      session.startTime,
      session.lastActivity,
      session.requestCount,
      session.totalInputTokens,
      session.totalOutputTokens,
      JSON.stringify(session.models),
      JSON.stringify(session.endpoints),
      session.toolsUsed ? JSON.stringify(session.toolsUsed) : null,
    )
}
