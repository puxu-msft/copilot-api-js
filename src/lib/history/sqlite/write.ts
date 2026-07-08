import type {
  //
  HistoryEntry,
  QueryOptions,
} from "~/lib/history/types"

import {
  //
  compress,
  compressAsync,
} from "./compression"
import { getDatabase } from "./connection"
import { applyWhere } from "./read"
import {
  //
  buildSearchIndexChunked,
  persistSearchIndex,
} from "./search-index-write"
import {
  //
  buildHeadRow,
  type EntryRow,
  extractHeadMetaPayload,
  extractStagePayloads,
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
  usage_normalized, stages_migrated,
  stop_reason, error_message,
  message_count, preview_text, response_preview_text,
  pid, boot_time, git_sha,
  request_bytes, response_bytes, multiplier,
  blob_gz
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  session_id = excluded.session_id, agent_id = excluded.agent_id, started_at = excluded.started_at, ended_at = excluded.ended_at,
  duration_ms = excluded.duration_ms, model = excluded.model, endpoint = excluded.endpoint,
  transport = excluded.transport, status = excluded.status,
  input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
  cache_read = excluded.cache_read, cache_creation = excluded.cache_creation,
  reasoning_tokens = excluded.reasoning_tokens, usage_normalized = excluded.usage_normalized,
  stages_migrated = excluded.stages_migrated, stop_reason = excluded.stop_reason,
  error_message = excluded.error_message, message_count = excluded.message_count,
  preview_text = excluded.preview_text,
  response_preview_text = excluded.response_preview_text,
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
    row.usage_normalized,
    row.stages_migrated,
    row.stop_reason,
    row.error_message,
    row.message_count,
    row.preview_text,
    row.response_preview_text,
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

/** Persist one stage row from an ALREADY-COMPRESSED blob (the async finalize path compresses off the event loop). */
function runStageInsertBlob(db: ReturnType<typeof getDatabase>, entryId: string, stage: string, attemptIndex: number, blob: Uint8Array, now: number): void {
  db.prepare(INSERT_STAGE_SQL).run(entryId, stage, attemptIndex, now, blob)
}

/**
 * Finalize a terminal entry: upsert the head row (terminal status), replace all
 * its stage rows, and recompute the session aggregate — atomically. Replacing
 * stage rows (DELETE + re-insert) keeps re-finalization idempotent.
 *
 * Two-phase (RFC history-finalize-async-offload §3): Phase 1 does the CPU-heavy
 * work (search-index build + zstd compression of every blob) OFF the event loop —
 * `compressAsync` runs on the libuv threadpool — with NO DB lock held. Phase 2 is a
 * fast SYNCHRONOUS transaction that only inserts the already-computed buffers.
 *
 * INVARIANT I7 (critical): the `db.transaction()` callback MUST stay synchronous —
 * bun:sqlite cannot provide atomicity across an `await` (an async callback's throw
 * does NOT roll back; `tx()` returns a pending Promise instead of throwing). All
 * awaiting happens in Phase 1, BEFORE the transaction opens.
 */
export async function insertCompletedEntry(entry: HistoryEntry): Promise<void> {
  const db = getDatabase()
  // ── Phase 1 — CPU off the event loop (no DB lock held) ──────────────────────
  // Build the search index (normalize/hash/jsdiff is CPU-heavy); the chunked builder
  // yields per message batch (P3) so it doesn't block concurrent streams in one go.
  // A malformed-shape throw degrades to an empty index without aborting finalize.
  const built = await buildSearchIndexChunked(entry)
  // Pack the redundant request bodies into one request_group dedup frame (B3);
  // response/sse stages stay individual. Compress the head blob + every stage blob
  // concurrently on the libuv threadpool. `rest`-then-group insert order is preserved.
  const { groupRow, rest } = partitionStagesForWrite(extractStagePayloads(entry))
  const stagesToCompress = groupRow ? [...rest, groupRow] : rest
  const [headBlob, ...stageBlobs] = await Promise.all([compressAsync(extractHeadMetaPayload(entry)), ...stagesToCompress.map((s) => compressAsync(s.payload))])
  const row = buildHeadRow(entry, undefined, headBlob)
  const precompressed = stagesToCompress.map((s, i) => ({ stage: s.stage, attemptIndex: s.attemptIndex, blob: stageBlobs[i] }))
  const now = Date.now()

  // ── Phase 2 — fast SYNCHRONOUS transaction (I7: callback MUST be sync) ───────
  const tx = db.transaction(() => {
    runHeadInsert(db, row)
    db.prepare("DELETE FROM entry_stages WHERE entry_id = ?").run(row.id)
    for (const s of precompressed) runStageInsertBlob(db, row.id, s.stage, s.attemptIndex, s.blob, now)
    // Content-addressed search index, atomic with head/stage. Sole search write path.
    persistSearchIndex(db, row.id, built)
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
 * Existence is read via a SELECT, NOT `.run().changes`: an UPDATE's `changes`
 * count can be inflated by any AFTER-write trigger/cascade, which would misreport
 * whether the head row matched (see reference-bun-sqlite-get-null-and-trigger-changes).
 */
export function setEntryPinned(id: string, pinned: boolean): boolean {
  const db = getDatabase()
  const exists = Boolean(db.prepare("SELECT 1 FROM entries_v2 WHERE id = ?").get(id))
  if (!exists) return false
  db.prepare("UPDATE entries_v2 SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id)
  return true
}

/**
 * Reclaim orphaned `msg_blob` rows — content-addressed blobs no longer referenced
 * by ANY `req_msg` (no FK, so CASCADE can't remove them). MUST run after a delete
 * that removed req_msg rows. `req_msg` / `req_aux` themselves CASCADE from
 * entries_v2 automatically (FK ON DELETE CASCADE). Shared by deleteSession + the
 * reaper (RFC C3: GC must hook EVERY delete site, else freed messages leak forever).
 */
export const GC_ORPHAN_MSG_BLOB_SQL = "DELETE FROM msg_blob WHERE NOT EXISTS (SELECT 1 FROM req_msg WHERE req_msg.hash = msg_blob.hash)"

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
    // req_msg/req_aux cascade-removed with the entries; sweep the now-orphaned blobs.
    if (deleted > 0) db.prepare(GC_ORPHAN_MSG_BLOB_SQL).run()
  })
  tx()
  return deleted
}

/**
 * Scoped delete: remove terminal entries matching the SAME filter set the list
 * query uses (reuses read.ts `applyWhere` for single-source WHERE), never the
 * in-flight persisted head rows (status NOT IN active states, so a streaming
 * request being finalized isn't yanked out from under the writer). Mirrors
 * `deleteSession`: DELETE FROM entries_v2 cascades req_msg/req_aux/entry_stages
 * (FK ON DELETE CASCADE); the now-orphaned content-addressed msg_blob rows are
 * swept by GC_ORPHAN_MSG_BLOB_SQL. Pinned rows are NOT exempt (deliberate delete
 * ignores pin, matching clear-all + deleteSession). Returns terminal rows deleted.
 */
export function deleteEntries(filters: QueryOptions): number {
  const db = getDatabase()
  const { sql: whereSql, params } = applyWhere(filters)
  const terminalGuard = "status NOT IN ('pending','executing','streaming')"
  const where = whereSql ? `${whereSql} AND ${terminalGuard}` : `WHERE ${terminalGuard}`
  let deleted = 0
  const tx = db.transaction(() => {
    // Count head rows BEFORE delete: entry_stages/req_msg/req_aux cascade, so
    // run().changes would include cascade rows and can't be the entry count.
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM entries_v2 ${where}`).get(...params) as { n: number }
    deleted = n
    db.prepare(`DELETE FROM entries_v2 ${where}`).run(...params)
    if (deleted > 0) db.prepare(GC_ORPHAN_MSG_BLOB_SQL).run()
  })
  tx()
  return deleted
}

export function clearAllEntries(): void {
  const db = getDatabase()
  const tx = db.transaction(() => {
    // entry_stages / req_msg / req_aux cascade from entries_v2 on row delete, but a
    // bare `DELETE FROM entries_v2` (no WHERE) still fires per-row cascade; the
    // explicit deletes are belt-and-suspenders and clearer intent. Clearing ALL
    // entries orphans EVERY msg_blob, so a bare DELETE beats a NOT EXISTS scan.
    db.prepare("DELETE FROM entry_stages").run()
    db.prepare("DELETE FROM entries_v2").run()
    db.prepare("DELETE FROM response_sessions").run()
    db.prepare("DELETE FROM msg_blob").run()
    db.prepare("DELETE FROM req_aux").run()
  })
  tx()
}

export function upsertResponseSession(responseId: string, sessionId: string): void {
  getDatabase().prepare("INSERT OR REPLACE INTO response_sessions (response_id, session_id) VALUES (?, ?)").run(responseId, sessionId)
}
