import consola from "consola"

import { state } from "~/lib/state"

import type { Database } from "./connection"

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
 * Copy ALL of one entry's rows into archive.* in a single archive-only transaction.
 * `SELECT *` is safe here: archive.db is built from the SAME SCHEMA_SQL +
 * migrateEntriesColumns as history.db, so columns are position-identical by
 * construction (asserted by the round-trip test). INSERT OR IGNORE makes the
 * whole copy idempotent for crash re-runs.
 */
function copyEntryToArchive(main: Database, entryId: string): void {
  const tx = main.transaction(() => {
    main.prepare("INSERT OR IGNORE INTO archive.entries_v2 SELECT * FROM main.entries_v2 WHERE id = ?").run(entryId)
    main.prepare("INSERT OR IGNORE INTO archive.entry_stages SELECT * FROM main.entry_stages WHERE entry_id = ?").run(entryId)
    main.prepare("INSERT OR IGNORE INTO archive.req_msg SELECT * FROM main.req_msg WHERE req_id = ?").run(entryId)
    main.prepare("INSERT OR IGNORE INTO archive.req_aux SELECT * FROM main.req_aux WHERE req_id = ?").run(entryId)
    // COPY (not move) the content-addressed message blobs this request references.
    main
      .prepare("INSERT OR IGNORE INTO archive.msg_blob SELECT * FROM main.msg_blob WHERE hash IN (SELECT hash FROM main.req_msg WHERE req_id = ?)")
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
    main.prepare("SELECT COUNT(*) n FROM archive.req_msg rm WHERE rm.req_id = ? AND NOT EXISTS (SELECT 1 FROM archive.msg_blob mb WHERE mb.hash = rm.hash)").get(entryId) as {
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
export function migrateEntriesToTier1(main: Database, ids: ReadonlyArray<string>): number {
  let moved = 0
  for (const id of ids) {
    if (moveEntryToTier1(main, id)) moved++
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
    return (main.prepare(`SELECT id FROM main.entries_v2 WHERE ${where} ORDER BY started_at ASC, id ASC LIMIT ?`).all(excess) as Array<{ id: string }>).map((r) => r.id)
  }
  const ids = [
    ...overflowIds("status = 'completed' AND pinned = 0", successLimit),
    ...overflowIds("status IN ('failed','aborted','interrupted') AND pinned = 0", failureLimit),
  ]
  return migrateEntriesToTier1(main, ids)
}

/**
 * Time-based main mechanism: move terminal non-pinned rows older than `hotDays`
 * into tier-1, oldest first, capped at `batchSize` per call (resumable — call
 * again until it returns 0). Returns the number moved this call.
 */
export function runTier1MigrationOnce(main: Database, opts: { hotDays: number; batchSize: number }): number {
  if (opts.hotDays <= 0) return 0
  const cutoff = Date.now() - opts.hotDays * 86400_000
  const ids = (
    main.prepare(`SELECT id FROM main.entries_v2 WHERE started_at < ? AND ${MIGRATABLE_WHERE} ORDER BY started_at ASC, id ASC LIMIT ?`).all(cutoff, opts.batchSize) as Array<{
      id: string
    }>
  ).map((r) => r.id)
  return migrateEntriesToTier1(main, ids)
}

/** Whether HOT→TIER-1 migration should run (config gate). */
export function isArchiveEnabled(): boolean {
  return state.historyArchiveEnabled
}
