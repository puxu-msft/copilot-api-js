import consola from "consola"

import type { QueryOptions } from "~/lib/history/types"

import { state } from "~/lib/state"

import type { Database } from "./connection"

import { ensureArchiveAttachedToMain } from "./archive-db"
import {
  //
  archiveWorkerControl,
  type ArchiveWorkerControl,
} from "./archive-worker"
import { applyWhere } from "./read"

/**
 * HOT→TIER-1 migration (spec 2026-07-14-history-tiered-archive §3.1/§3.4/§3.5).
 *
 * Replaces the reaper's lossy count-based DELETE with a MOVE into archive.db:
 * old/overflow terminal rows cool down to tier-1 instead of being destroyed
 * (never-truly-delete red line).
 *
 * Atomicity model (reviewer B2, WAL has NO cross-file atomicity): the archive.db
 * is ATTACHed onto the main history.db connection AS `archive`, and the move runs
 * as TWO single-file-atomic transactions with an explicit verify between them:
 *
 *   1. write archive.* ONLY  (one transaction → touches only archive.db's file)
 *   2. verify all sub-tables copied (head + every entry_stages + req_msg/req_aux
 *      + msg_blob referential integrity)
 *   3. delete main.* ONLY    (one transaction → touches only history.db's file)
 *
 * If a crash lands between 1 and 3, the row exists in BOTH DBs; the re-run is
 * idempotent — INSERT OR IGNORE skips the re-copy but STILL verifies and deletes
 * HOT, so it never leaves a "both-have" duplicate (never a "delete integer entry
 * before archive is complete").
 *
 * msg_blob is COPIED not moved (§3.5): content-addressed rows are shared across
 * requests, so a hash still referenced by a HOT row must ALSO land in archive
 * (else the archive-side search INNER JOIN silently drops the message). HOT-side
 * orphan GC is unchanged; archive-side orphan GC runs once per batch here.
 */

/** Terminal, non-pinned predicate — mirrors the reaper's bucket predicates (both include `pinned = 0`). */
const MIGRATABLE_WHERE = "status IN ('completed','failed','aborted','interrupted') AND pinned = 0"

/** Archive-side orphan GC (mirror of GC_ORPHAN_MSG_BLOB_SQL but on the archive schema). */
const GC_ARCHIVE_ORPHAN_MSG_BLOB_SQL =
  "DELETE FROM archive.msg_blob WHERE NOT EXISTS (SELECT 1 FROM archive.req_msg WHERE archive.req_msg.hash = archive.msg_blob.hash)"

/**
 * Ordered column-name list of a table. Used to build EXPLICIT-column cross-db
 * `INSERT ... SELECT` — a bare `SELECT *` binds by POSITION, and entries_v2's
 * physical column order differs between a fresh archive.db (SCHEMA_SQL CREATE
 * order) and any real ALTER-upgraded history.db (ALTER appends to the end), so
 * `SELECT *` misaligns values into the wrong columns (reviewer BLOCKER-1,
 * reproduced on the real 32 GB DB → FK violation / corruption). Column NAMES are
 * identical across both DBs (same schema source), so an explicit name list aligns
 * by name regardless of physical order. Not cached — the PRAGMA is cheap and a
 * process-global cache would risk cross-test schema poisoning.
 */
function columnList(main: Database, table: string): string {
  return (main.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name).join(", ")
}

/**
 * Copy ALL of one entry's rows into archive.* in a single archive-only transaction,
 * OVERWRITING any pre-existing archive rows for this id so archive always reflects
 * HOT's CURRENT content (reviewer BLOCKER-2: a crash-recovery re-run must not keep
 * a stale archive row that a background backfill has since corrected in HOT — verify
 * only checks counts, not content, so we make the invariant "archive == HOT now"
 * hold by construction). EXPLICIT column names (not `SELECT *`) align by name across
 * the two DBs' differing physical column orders (BLOCKER-1).
 *
 * msg_blob stays `INSERT OR IGNORE`: it is content-addressed (hash → immutable
 * content), so a shared hash never needs overwriting and must NOT be moved (§3.5).
 */
function copyEntryToArchive(main: Database, entryId: string): void {
  const entriesCols = columnList(main, "entries_v2")
  const stagesCols = columnList(main, "entry_stages")
  const reqMsgCols = columnList(main, "req_msg")
  const reqAuxCols = columnList(main, "req_aux")
  const msgBlobCols = columnList(main, "msg_blob")
  const tx = main.transaction(() => {
    // Overwrite: drop any stale archive rows for this id first (entry_stages /
    // req_msg / req_aux cascade from the head delete), then re-copy from HOT.
    main.prepare("DELETE FROM archive.entries_v2 WHERE id = ?").run(entryId)
    main.prepare(`INSERT INTO archive.entries_v2 (${entriesCols}) SELECT ${entriesCols} FROM main.entries_v2 WHERE id = ?`).run(entryId)
    main.prepare(`INSERT INTO archive.entry_stages (${stagesCols}) SELECT ${stagesCols} FROM main.entry_stages WHERE entry_id = ?`).run(entryId)
    main.prepare(`INSERT INTO archive.req_msg (${reqMsgCols}) SELECT ${reqMsgCols} FROM main.req_msg WHERE req_id = ?`).run(entryId)
    main.prepare(`INSERT INTO archive.req_aux (${reqAuxCols}) SELECT ${reqAuxCols} FROM main.req_aux WHERE req_id = ?`).run(entryId)
    // COPY (not move) the content-addressed message blobs this request references.
    main
      .prepare(
        `INSERT OR IGNORE INTO archive.msg_blob (${msgBlobCols}) SELECT ${msgBlobCols} FROM main.msg_blob WHERE hash IN (SELECT hash FROM main.req_msg WHERE req_id = ?)`,
      )
      .run(entryId)
  })
  tx()
}

/**
 * Verify every sub-table of `entryId` is fully present in archive.* before HOT
 * deletion. Returns true only when head exists AND stage/req_msg/req_aux counts
 * match HOT AND every archive.req_msg.hash resolves in archive.msg_blob.
 */
function verifyEntryInArchive(main: Database, entryId: string): boolean {
  const headOk = Boolean(main.prepare("SELECT 1 FROM archive.entries_v2 WHERE id = ?").get(entryId))
  if (!headOk) return false
  const pairCount = (table: string, keyCol: string) => {
    const a = (main.prepare(`SELECT COUNT(*) n FROM archive.${table} WHERE ${keyCol} = ?`).get(entryId) as { n: number }).n
    const h = (main.prepare(`SELECT COUNT(*) n FROM main.${table} WHERE ${keyCol} = ?`).get(entryId) as { n: number }).n
    return a === h
  }
  if (!pairCount("entry_stages", "entry_id")) return false
  if (!pairCount("req_msg", "req_id")) return false
  if (!pairCount("req_aux", "req_id")) return false
  // Referential integrity: no archive.req_msg hash may dangle (msg_blob must have been copied).
  const dangling = (
    main
      .prepare("SELECT COUNT(*) n FROM archive.req_msg rm WHERE rm.req_id = ? AND NOT EXISTS (SELECT 1 FROM archive.msg_blob mb WHERE mb.hash = rm.hash)")
      .get(entryId) as {
      n: number
    }
  ).n
  return dangling === 0
}

/** Delete one entry's HOT rows (cascade removes its entry_stages / req_msg / req_aux) in a main-only transaction. */
function deleteEntryFromHot(main: Database, entryId: string): void {
  const tx = main.transaction(() => {
    main.prepare("DELETE FROM main.entries_v2 WHERE id = ?").run(entryId)
  })
  tx()
}

/**
 * Move ONE entry HOT→TIER-1 (copy → verify → delete-HOT). Idempotent: an entry
 * already (partially) in archive is re-copied via INSERT OR IGNORE, re-verified,
 * and only deleted from HOT once verification passes. Returns true if the row is
 * now safely in archive and gone from HOT; false if verification failed (HOT
 * left intact for a later retry — never a lossy delete).
 */
export function moveEntryToTier1(main: Database, entryId: string): boolean {
  // Idempotent guard: if the row is already gone from HOT it was migrated by a
  // prior (verified) run — treat as a no-op success iff archive still holds it.
  // (verifyEntryInArchive compares archive-vs-HOT counts, which would falsely
  // fail here since HOT is now empty; the driver never selects gone ids, but a
  // recovery re-run or a double-call must stay a stable no-op.)
  const inHot = Boolean(main.prepare("SELECT 1 FROM main.entries_v2 WHERE id = ?").get(entryId))
  if (!inHot) return Boolean(main.prepare("SELECT 1 FROM archive.entries_v2 WHERE id = ?").get(entryId))

  copyEntryToArchive(main, entryId)
  if (!verifyEntryInArchive(main, entryId)) {
    consola.warn(`[history/tier1] verify failed for ${entryId} — leaving HOT copy intact for retry`)
    return false
  }
  deleteEntryFromHot(main, entryId)
  return true
}

/** Sweep archive-side msg_blob rows orphaned by a batch of moves (mirror of the HOT-side GC). */
export function gcArchiveOrphanMsgBlobs(main: Database): void {
  main.prepare(GC_ARCHIVE_ORPHAN_MSG_BLOB_SQL).run()
}

/**
 * Move a batch of entries HOT→TIER-1 by id, then GC archive-side orphan msg_blobs
 * once. Powers both the manual "archive now" trigger and the time/overflow drivers.
 * Returns the number successfully moved.
 */
/**
 * Batch-level precheck: does archive.* cover every column the explicit-column copy
 * will reference (main's column set ⊆ archive's, for all 5 tables)? A schema drift
 * (archive.db's independent 001+ migration lagging behind HOT's, or a future column
 * added to HOT but not yet to archive) makes the copy INSERT reference an
 * archive-missing column → every entry in the batch throws the SAME error. Without
 * this precheck, per-entry try/catch catches but does NOT isolate (the mismatch is
 * GLOBAL, not per-row) → the WHOLE batch fails 0-moved and the count safety valve
 * silently stops working (reviewer BLOCKER). Fail the batch FAST with ONE clear
 * "archive schema behind HOT" warning instead of N near-identical per-entry ones.
 */
function archiveSchemaCovers(main: Database): boolean {
  for (const table of ["entries_v2", "entry_stages", "req_msg", "req_aux", "msg_blob"]) {
    const mainCols = new Set((main.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name))
    const archiveCols = new Set((main.prepare(`PRAGMA archive.table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name))
    for (const c of mainCols) if (!archiveCols.has(c)) return false
  }
  return true
}

export function migrateEntriesToTier1(main: Database, ids: ReadonlyArray<string>): number {
  if (ids.length === 0) return 0
  // Batch-level schema-drift guard (reviewer BLOCKER): if archive.db can't cover
  // HOT's columns, skip the WHOLE batch with ONE warning rather than letting every
  // entry fail identically. Fail-closed: rows stay in HOT for a later retry once
  // archive.db's schema catches up (an observable "migration paused" signal).
  if (!archiveSchemaCovers(main)) {
    consola.warn(
      "[history/tier1] archive.db schema is behind HOT (missing columns) — tier-1 migration paused this pass; will resume once archive migrations catch up",
    )
    return 0
  }
  let moved = 0
  for (const id of ids) {
    // Per-entry fault isolation: a single corrupt row that throws must NOT abort the
    // whole batch — log it and continue; it stays in HOT for a later retry (fail-closed).
    try {
      if (moveEntryToTier1(main, id)) moved++
    } catch (err: unknown) {
      consola.warn(`[history/tier1] move failed for ${id} (left in HOT for retry)`, err)
    }
  }
  if (moved > 0) gcArchiveOrphanMsgBlobs(main)
  return moved
}

/**
 * Count safety-valve: move the OLDEST terminal non-pinned rows beyond each bucket
 * limit into tier-1 (instead of the reaper's DELETE). Mirrors evictBucket's
 * selection (ORDER BY started_at ASC, id ASC LIMIT excess) per success/failure
 * bucket. Returns the number moved.
 */
export function migrateOverflowToTier1(main: Database, successLimit: number, failureLimit: number): number {
  const overflowIds = (where: string, limit: number): Array<string> => {
    if (limit <= 0) return []
    const { n } = main.prepare(`SELECT COUNT(*) AS n FROM main.entries_v2 WHERE ${where}`).get() as { n: number }
    if (n <= limit) return []
    const excess = n - limit
    return (main.prepare(`SELECT id FROM main.entries_v2 WHERE ${where} ORDER BY started_at ASC, id ASC LIMIT ?`).all(excess) as Array<{ id: string }>).map(
      (r) => r.id,
    )
  }
  const ids = [
    ...overflowIds("status = 'completed' AND pinned = 0", successLimit),
    ...overflowIds("status IN ('failed','aborted','interrupted') AND pinned = 0", failureLimit),
  ]
  return migrateEntriesToTier1(main, ids)
}

/**
 * Session-atomic selection for the time-based pass ("写 tier-1 时按 session-id
 * 聚合"): pick the OLDEST fully-cold sessions and move ALL their migratable
 * entries together, so a session is never split across HOT and tier-1. Keeping a
 * session whole through HOT→tier-1 is the precondition for tier-2's per-session
 * group compression to see the complete session (where the cross-request
 * redundancy folds). A session is "cold" only when its LAST activity (MAX over ALL
 * its rows, incl. active/pinned) is older than `cutoff`, so a still-active session
 * is never cooled. Pinned entries stay in HOT (pin = keep raw forever) — the only
 * intentional split. Whole sessions accumulate until `batchSize` is reached (a
 * single large session may exceed it — never split). NULL-session entries
 * (ungroupable) fall back to individual oldest-first selection to fill the batch.
 */
function coldSessionAtomicIds(main: Database, cutoff: number, batchSize: number): Array<string> {
  const sessions = main
    .prepare(
      `SELECT session_id AS sid FROM main.entries_v2
       WHERE session_id IS NOT NULL
       GROUP BY session_id
       HAVING MAX(started_at) < ? AND SUM(CASE WHEN ${MIGRATABLE_WHERE} THEN 1 ELSE 0 END) > 0
       ORDER BY MIN(started_at) ASC`,
    )
    .all(cutoff) as Array<{ sid: string }>
  const ids: Array<string> = []
  for (const { sid } of sessions) {
    const sessionIds = (
      main.prepare(`SELECT id FROM main.entries_v2 WHERE session_id = ? AND ${MIGRATABLE_WHERE} ORDER BY started_at ASC, id ASC`).all(sid) as Array<{
        id: string
      }>
    ).map((r) => r.id)
    ids.push(...sessionIds)
    if (ids.length >= batchSize) return ids
  }
  // Fill remaining budget with ungroupable (NULL-session) cold entries, oldest-first.
  if (ids.length < batchSize) {
    const rest = (
      main
        .prepare(`SELECT id FROM main.entries_v2 WHERE session_id IS NULL AND started_at < ? AND ${MIGRATABLE_WHERE} ORDER BY started_at ASC, id ASC LIMIT ?`)
        .all(cutoff, batchSize - ids.length) as Array<{ id: string }>
    ).map((r) => r.id)
    ids.push(...rest)
  }
  return ids
}

/**
 * Time-based main mechanism: move terminal non-pinned rows of fully-cold sessions
 * into tier-1, oldest SESSION first, session-atomic (never splitting a session),
 * capped near `batchSize` entries per call (resumable — call again until it returns
 * 0). Returns the number moved this call.
 */
export function runTier1MigrationOnce(main: Database, opts: { hotDays: number; batchSize: number }): number {
  if (opts.hotDays <= 0) return 0
  const cutoff = Date.now() - opts.hotDays * 86400_000
  return migrateEntriesToTier1(main, coldSessionAtomicIds(main, cutoff, opts.batchSize))
}

/**
 * Drain the entire >hot_days backlog by calling `runTier1MigrationOnce` in bounded
 * batches until a pass moves 0 rows (or a safety bound is hit). Shared by the
 * startup cool-down (startHistoryBackfills) and the manual on-demand cool-down
 * endpoint. Returns the TOTAL number moved across all batches this call.
 */
export function drainTier1Backlog(main: Database, opts: { hotDays: number; batchSize: number; maxBatches?: number }): number {
  let total = 0
  let guard = opts.maxBatches ?? 10_000
  while (guard-- > 0) {
    const n = runTier1MigrationOnce(main, opts)
    if (n === 0) break
    total += n
  }
  return total
}

/**
 * Background counterpart of {@link drainTier1Backlog}. Each migration batch is
 * a durable unit (every entry copy→verify→delete is committed). After a batch,
 * yield and honor the archive shutdown seal before selecting another batch.
 */
export async function runTier1BacklogWorker(
  main: Database,
  opts: { hotDays: number; batchSize: number; maxBatches?: number },
  control: ArchiveWorkerControl = archiveWorkerControl,
): Promise<number> {
  let total = 0
  let guard = opts.maxBatches ?? 10_000
  while (guard-- > 0 && !control.shouldStop()) {
    const moved = runTier1MigrationOnce(main, opts)
    if (moved === 0) break
    total += moved
    if (await control.checkpoint()) break
  }
  return total
}

/** Whether HOT→TIER-1 migration should run (config gate). */
export function isArchiveEnabled(): boolean {
  return state.historyArchiveEnabled
}

/**
 * Manual "archive now" trigger (spec §3.6): the product-facing replacement for the
 * removed delete API. Moves the terminal, non-pinned HOT rows matching `filters`
 * (or ALL of them when no filter is given) into tier-1 — NOT a delete. Ignores the
 * `hot_days` threshold (the user's intent is "move these out of my hot view now")
 * and always excludes pinned rows (pin = keep raw data forever in HOT). Ensures
 * archive.db is attached first. Returns the number archived.
 */
export function archiveNow(main: Database, filters?: QueryOptions): number {
  if (!state.historyArchiveEnabled) return 0
  ensureArchiveAttachedToMain(main)
  const { sql: filterSql, params } = applyWhere(filters)
  // Intersect the caller's list filter with "terminal + non-pinned" (never move an
  // active or pinned row). applyWhere emits a leading `WHERE ...`; splice our
  // predicate in with AND, or start a fresh WHERE when there was no filter.
  const where = filterSql ? `${filterSql} AND ${MIGRATABLE_WHERE}` : `WHERE ${MIGRATABLE_WHERE}`
  const ids = (main.prepare(`SELECT id FROM main.entries_v2 ${where} ORDER BY started_at ASC, id ASC`).all(...params) as Array<{ id: string }>).map((r) => r.id)
  return migrateEntriesToTier1(main, ids)
}
