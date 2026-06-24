import type {
  //
  HistoryEntry,
} from "~/lib/history/types"

import { compress } from "./compression"
import { getDatabase } from "./connection"
import {
  //
  type EntryRow,
  partitionStagesForWrite,
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
  id, session_id, agent_id, started_at, ended_at, duration_ms,
  model, endpoint, transport, status,
  input_tokens, output_tokens, cache_read, cache_creation, reasoning_tokens,
  stop_reason, error_message,
  message_count, preview_text, search_text,
  pid, boot_time, git_sha,
  request_bytes, response_bytes, multiplier,
  blob_gz
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  session_id = excluded.session_id, agent_id = excluded.agent_id, started_at = excluded.started_at, ended_at = excluded.ended_at,
  duration_ms = excluded.duration_ms, model = excluded.model, endpoint = excluded.endpoint,
  transport = excluded.transport, status = excluded.status,
  input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
  cache_read = excluded.cache_read, cache_creation = excluded.cache_creation,
  reasoning_tokens = excluded.reasoning_tokens, stop_reason = excluded.stop_reason,
  error_message = excluded.error_message, message_count = excluded.message_count,
  preview_text = excluded.preview_text, search_text = excluded.search_text,
  pid = excluded.pid, boot_time = excluded.boot_time, git_sha = excluded.git_sha,
  request_bytes = excluded.request_bytes, response_bytes = excluded.response_bytes, multiplier = excluded.multiplier,
  blob_gz = excluded.blob_gz
`

/** Stage-row upsert. Plain `INSERT OR REPLACE` is safe — entry_stages has no children, so REPLACE cascades nothing. */
const INSERT_STAGE_SQL = `
INSERT OR REPLACE INTO entry_stages (entry_id, stage, attempt_index, created_at, blob_gz)
VALUES (?,?,?,?,?)
`

/** Bind + run the head-row upsert for one EntryRow. */
function runHeadInsert(db: ReturnType<typeof getDatabase>, row: EntryRow): void {
  db.prepare(INSERT_ENTRY_SQL).run(
    row.id,
    row.session_id,
    row.agent_id,
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
    row.request_bytes,
    row.response_bytes,
    row.multiplier,
    row.blob_gz,
  )
}

/** Persist one stage payload (gzip + upsert). Head row MUST already exist (FK). */
function runStageInsert(db: ReturnType<typeof getDatabase>, entryId: string, stage: StagePayload, now: number): void {
  db.prepare(INSERT_STAGE_SQL).run(entryId, stage.stage, stage.attemptIndex, now, compress(stage.payload))
}

/**
 * Finalize a terminal entry: upsert the head row (terminal status), replace all
 * its stage rows, and recompute the session aggregate — atomically. Replacing
 * stage rows (DELETE + re-insert) keeps re-finalization idempotent.
 */
export function insertCompletedEntry(entry: HistoryEntry): void {
  const db = getDatabase()
  const { row, stages } = serializeHeadEntry(entry)
  const now = Date.now()

  const tx = db.transaction(() => {
    runHeadInsert(db, row)
    db.prepare("DELETE FROM entry_stages WHERE entry_id = ?").run(row.id)
    // Pack the redundant request bodies into one request_group dedup frame
    // (B3); response/sse stages stay individual. DELETE+rewrite stays atomic.
    const { groupRow, rest } = partitionStagesForWrite(stages)
    for (const stage of rest) runStageInsert(db, row.id, stage, now)
    if (groupRow) runStageInsert(db, row.id, groupRow, now)
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

/**
 * Set (or clear) the debug-pin flag on one entry. Returns whether a row with
 * `id` exists (true even if the flag was already in the requested state — the
 * UPDATE is idempotent). The dedicated UPDATE is the ONLY writer of the `pinned`
 * column; INSERT_ENTRY_SQL deliberately omits it, so a head re-upsert never
 * resets a pinned row.
 *
 * Existence is read via a SELECT, NOT `.run().changes`: the entries_fts AFTER
 * UPDATE trigger writes trigram rows that bun:sqlite folds into `changes`, which
 * would misreport whether the head row matched (see
 * reference-bun-sqlite-get-null-and-trigger-changes).
 */
export function setEntryPinned(id: string, pinned: boolean): boolean {
  const db = getDatabase()
  const exists = Boolean(db.prepare("SELECT 1 FROM entries_v2 WHERE id = ?").get(id))
  if (!exists) return false
  db.prepare("UPDATE entries_v2 SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id)
  return true
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
    db.prepare("DELETE FROM response_sessions").run()
  })
  tx()
}

export function upsertResponseSession(responseId: string, sessionId: string): void {
  getDatabase().prepare("INSERT OR REPLACE INTO response_sessions (response_id, session_id) VALUES (?, ?)").run(responseId, sessionId)
}
