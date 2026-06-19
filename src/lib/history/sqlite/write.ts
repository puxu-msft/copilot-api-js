import type {
  //
  HistoryEntry,
  Session,
} from "~/lib/history/types"

import {
  //
  type LineageDigest,
  packTurnHashes,
} from "~/lib/history/lineage"

import { compress } from "./compression"
import { getDatabase } from "./connection"
import {
  //
  type EntryRow,
  serializeHeadEntry,
  type StagePayload,
} from "./serialize"

/**
 * Head-row upsert. MUST be `ON CONFLICT DO UPDATE`, NOT `INSERT OR REPLACE`:
 * the latter does DELETE+INSERT, which fires `entry_stages` ON DELETE CASCADE
 * and would wipe all stage rows on every incremental status update. DO UPDATE
 * mutates the row in place, leaving the child stage rows intact.
 */
const INSERT_ENTRY_SQL = `
INSERT INTO entries_v2 (
  id, session_id, started_at, ended_at, duration_ms,
  model, endpoint, transport, status,
  input_tokens, output_tokens, cache_read, cache_creation, reasoning_tokens,
  stop_reason, error_message,
  message_count, preview_text, search_text,
  pid, boot_time, git_sha,
  blob_gz
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  session_id = excluded.session_id, started_at = excluded.started_at, ended_at = excluded.ended_at,
  duration_ms = excluded.duration_ms, model = excluded.model, endpoint = excluded.endpoint,
  transport = excluded.transport, status = excluded.status,
  input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
  cache_read = excluded.cache_read, cache_creation = excluded.cache_creation,
  reasoning_tokens = excluded.reasoning_tokens, stop_reason = excluded.stop_reason,
  error_message = excluded.error_message, message_count = excluded.message_count,
  preview_text = excluded.preview_text, search_text = excluded.search_text,
  pid = excluded.pid, boot_time = excluded.boot_time, git_sha = excluded.git_sha,
  blob_gz = excluded.blob_gz
`

/** Stage-row upsert. Plain `INSERT OR REPLACE` is safe — entry_stages has no children, so REPLACE cascades nothing. */
const INSERT_STAGE_SQL = `
INSERT OR REPLACE INTO entry_stages (entry_id, stage, attempt_index, created_at, blob_gz)
VALUES (?,?,?,?,?)
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

/**
 * Active (non-terminal) statuses. Eager persistence writes a head row at
 * request start (status=pending) and on each transition, so the entries table
 * now contains in-progress rows. Session/stats aggregates must EXCLUDE these —
 * otherwise request_count/token sums count requests that have not finished,
 * shifting their meaning from "completed" to "received".
 */
const ACTIVE_STATUS_SQL = `status IN ('pending','executing','streaming')`

const RECOMPUTE_SESSION_AGGREGATES_SQL = `
SELECT
  COUNT(*) AS request_count,
  COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
  COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
  MIN(started_at) AS start_time,
  COALESCE(MAX(ended_at), MAX(started_at)) AS last_activity
FROM entries_v2
WHERE session_id = ? AND NOT (${ACTIVE_STATUS_SQL})
`

/**
 * Distinct model / endpoint set used across all entries in the session.
 * `models_json` and `endpoints_json` are not numeric — they need their own
 * recompute query because GROUP_CONCAT(DISTINCT) does not coexist with the
 * scalar aggregates above in a single non-GROUP-BY SELECT in SQLite.
 */
const RECOMPUTE_SESSION_MODELS_SQL = `
SELECT DISTINCT model FROM entries_v2 WHERE session_id = ? AND model IS NOT NULL ORDER BY model
`
const RECOMPUTE_SESSION_ENDPOINTS_SQL = `
SELECT DISTINCT endpoint FROM entries_v2 WHERE session_id = ? AND endpoint IS NOT NULL ORDER BY endpoint
`

/** Bind + run the head-row upsert for one EntryRow. */
function runHeadInsert(db: ReturnType<typeof getDatabase>, row: EntryRow): void {
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
    row.pid,
    row.boot_time,
    row.git_sha,
    row.blob_gz,
  )
}

/** Persist one stage payload (gzip + upsert). Head row MUST already exist (FK). */
function runStageInsert(db: ReturnType<typeof getDatabase>, entryId: string, stage: StagePayload, now: number): void {
  db.prepare(INSERT_STAGE_SQL).run(entryId, stage.stage, stage.attemptIndex, now, compress(stage.payload))
}

/** Recompute and upsert the session aggregate row from terminal entries only. */
function recomputeSession(db: ReturnType<typeof getDatabase>, sessionId: string): void {
  const agg = db.prepare(RECOMPUTE_SESSION_AGGREGATES_SQL).get(sessionId) as {
    request_count: number
    total_input_tokens: number
    total_output_tokens: number
    start_time: number
    last_activity: number
  } | null
  if (!agg || agg.request_count <= 0) return

  const modelRows = db.prepare(RECOMPUTE_SESSION_MODELS_SQL).all(sessionId) as Array<{ model: string | null }>
  const endpointRows = db.prepare(RECOMPUTE_SESSION_ENDPOINTS_SQL).all(sessionId) as Array<{ endpoint: string | null }>
  const models = modelRows.map((r) => r.model).filter((m): m is string => typeof m === "string" && m.length > 0)
  const endpoints = endpointRows.map((r) => r.endpoint).filter((e): e is string => typeof e === "string" && e.length > 0)

  // Preserve any tools_used_json the session already had — recompute only
  // covers entries-derivable aggregates; tools_used is set out-of-band via
  // upsertSessionMeta and must not be silently nulled on every insert.
  const existing = db.prepare("SELECT tools_used_json FROM sessions WHERE id = ?").get(sessionId) as { tools_used_json: string | null } | undefined
  const toolsUsedJson = existing?.tools_used_json ?? null

  db.prepare(UPSERT_SESSION_SQL).run(
    sessionId,
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

/**
 * Persist a lineage digest for an entry. Called inside the
 * `insertCompletedEntry` transaction so the lineage row lands atomically with
 * the head + stage rows (RFC §4.2). Idempotent on re-finalize:
 *  - `INSERT OR REPLACE` on entry_lineage rewrites with the latest digest.
 *  - `INSERT OR IGNORE` on entry_produced_tool_ids tolerates exact duplicates
 *     (composite PK `(tool_use_id, entry_id)` — see schema for rationale).
 *  - The pre-DELETE wipes any stale ids that the new digest no longer mints.
 */
function runLineageInsert(db: ReturnType<typeof getDatabase>, entryId: string, digest: LineageDigest): void {
  db.prepare(
    `INSERT OR REPLACE INTO entry_lineage
       (entry_id, schema_version, root_hash, turn_hashes_blob, post_response_hash, back_tool_use_id, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(entryId, digest.v, digest.rootHash, packTurnHashes(digest.turnHashes), digest.postResponseHash, digest.backToolUseId, digest.computedAt)

  db.prepare("DELETE FROM entry_produced_tool_ids WHERE entry_id = ?").run(entryId)
  if (digest.producedToolUseIds.length > 0) {
    const stmt = db.prepare("INSERT OR IGNORE INTO entry_produced_tool_ids (tool_use_id, entry_id) VALUES (?, ?)")
    for (const toolUseId of digest.producedToolUseIds) {
      stmt.run(toolUseId, entryId)
    }
  }
}

/**
 * Finalize a terminal entry: upsert the head row (terminal status), replace all
 * its stage rows, persist the lineage digest (if any), and recompute the
 * session aggregate — atomically. Replacing stage rows (DELETE + re-insert)
 * keeps re-finalization idempotent. The `digest` argument is optional so
 * existing test callers and the legacy code path continue to work; per RFC §11
 * the digest is computed OUTSIDE the transaction and passed in here — a compute
 * failure logs + writes the entry without lineage, never blocking the request.
 */
export function insertCompletedEntry(entry: HistoryEntry, digest?: LineageDigest): void {
  const db = getDatabase()
  const { row, stages } = serializeHeadEntry(entry)
  const now = Date.now()

  const tx = db.transaction(() => {
    runHeadInsert(db, row)
    db.prepare("DELETE FROM entry_stages WHERE entry_id = ?").run(row.id)
    for (const stage of stages) runStageInsert(db, row.id, stage, now)
    if (digest) runLineageInsert(db, row.id, digest)
    if (row.session_id) recomputeSession(db, row.session_id)
  })
  tx()
}

/**
 * Incremental head-row upsert (eager + on each transition). Does NOT recompute
 * the session aggregate — active rows are excluded from aggregates, and the
 * recompute happens at finalize. `statusOverride` sets pending/streaming without
 * mutating the entry object. Optionally writes stage rows in the SAME
 * transaction (used by the eager first write so head + inbound_request land
 * together, never leaving the head pointing at a missing stage).
 */
export function upsertHeadRow(entry: HistoryEntry, statusOverride?: string, stagesToWrite?: Array<StagePayload>): void {
  const db = getDatabase()
  const { row } = serializeHeadEntry(entry, statusOverride)
  const now = Date.now()
  const tx = db.transaction(() => {
    runHeadInsert(db, row)
    if (stagesToWrite) for (const stage of stagesToWrite) runStageInsert(db, row.id, stage, now)
  })
  tx()
}

/** Incremental single stage-row upsert. Head row MUST already exist (FK). */
export function upsertStageRow(entryId: string, stage: StagePayload): void {
  const db = getDatabase()
  runStageInsert(db, entryId, stage, Date.now())
}

export function deleteSession(sessionId: string): number {
  const db = getDatabase()
  let deleted = 0
  const tx = db.transaction(() => {
    // Count head rows BEFORE delete: with entry_stages ON DELETE CASCADE,
    // `run().changes` would include cascade-deleted stage rows, so it can't be
    // used as the entry count.
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM entries_v2 WHERE session_id = ?").get(sessionId) as { n: number }
    deleted = n
    db.prepare("DELETE FROM entries_v2 WHERE session_id = ?").run(sessionId)
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId)
  })
  tx()
  return deleted
}

export function clearAllEntries(): void {
  const db = getDatabase()
  const tx = db.transaction(() => {
    // entry_stages cascades from entries_v2 on row delete, but a bare
    // `DELETE FROM entries_v2` (no WHERE) still fires per-row cascade; the
    // explicit delete is belt-and-suspenders and clearer intent.
    db.prepare("DELETE FROM entry_stages").run()
    db.prepare("DELETE FROM entries_v2").run()
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
