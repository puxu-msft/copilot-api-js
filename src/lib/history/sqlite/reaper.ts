import consola from "consola"

import { getProcessIdentity } from "~/lib/process-identity"
import { state } from "~/lib/state"

import type { Database } from "./connection"

import { getDatabase } from "./connection"

let timer: ReturnType<typeof setInterval> | null = null

/**
 * SQL predicates partitioning entries_v2 into success / failure buckets.
 *
 * Only TERMINAL rows are bucketed. Active rows (pending/executing/streaming),
 * introduced by eager persistence, fall OUTSIDE both buckets so the reaper never
 * counts or evicts an in-progress request's head row. Their backstop is
 * `reclaimStaleActiveRows` (runtime) + startup orphan recovery, which flip a
 * stuck/dead row to `interrupted` (a failure-bucket terminal state).
 */
const FAILURE_WHERE = "status IN ('failed','aborted','interrupted')"
const SUCCESS_WHERE = "status = 'completed'"

/** Active (non-terminal) statuses — reaper-exempt; reclaimed only via interrupted. */
const ACTIVE_STATUSES = ["pending", "executing", "streaming"]

/** Evict the oldest rows in one status bucket beyond `limit`. Returns the head-row count evicted. */
function evictBucket(db: Database, where: string, limit: number): number {
  if (limit <= 0) return 0
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM entries_v2 WHERE ${where}`).get() as { n: number }
  if (n <= limit) return 0
  const excess = n - limit
  db.prepare(
    `DELETE FROM entries_v2 WHERE id IN (
       SELECT id FROM entries_v2 WHERE ${where} ORDER BY started_at ASC, id ASC LIMIT ?
     )`,
  ).run(excess)
  // Return `excess`, NOT result.changes: with entry_stages ON DELETE CASCADE,
  // `changes` counts cascade-deleted stage rows too. The subquery targets exactly
  // `excess` head rows (n > limit guarantees they exist), so that is the head count.
  return excess
}

export function runReaperOnce(successLimit: number, failureLimit: number): number {
  const db = getDatabase()
  const deletedSuccess = evictBucket(db, SUCCESS_WHERE, successLimit)
  const deletedFailure = evictBucket(db, FAILURE_WHERE, failureLimit)
  const deleted = deletedSuccess + deletedFailure
  if (deleted > 0) {
    consola.info(
      `[history/sqlite] reaper evicted ${deletedSuccess} success (limit=${successLimit}) + ${deletedFailure} failure (limit=${failureLimit}) entries`,
    )
  }
  return deleted
}

/**
 * Reclaim THIS process's stale active rows (pending/executing/streaming older
 * than `maxAgeMs`) by flipping them to `interrupted`. Defense-in-depth backstop
 * for a same-process row whose in-flight context vanished without finalizing —
 * a foreign-pid stuck row is a crashed-process orphan handled at startup
 * instead. Returns the number reclaimed. `maxAgeMs<=0` disables it.
 */
export function reclaimStaleActiveRows(maxAgeMs: number = state.staleRequestMaxAge * 1000): number {
  if (maxAgeMs <= 0) return 0
  const db = getDatabase()
  const { pid } = getProcessIdentity()
  const cutoff = Date.now() - maxAgeMs
  const placeholders = ACTIVE_STATUSES.map(() => "?").join(",")
  const result = db
    .prepare(`UPDATE entries_v2 SET status = 'interrupted', ended_at = COALESCE(ended_at, ?) WHERE status IN (${placeholders}) AND pid = ? AND started_at < ?`)
    .run(cutoff, ...ACTIVE_STATUSES, pid, cutoff)
  if (result.changes > 0) consola.info(`[history/sqlite] reaper reclaimed ${result.changes} stale active row(s) → interrupted`)
  return result.changes
}

export function startReaper(successLimit: number, failureLimit: number, intervalSeconds: number): void {
  stopReaper()
  if (intervalSeconds <= 0 || (successLimit <= 0 && failureLimit <= 0)) return
  timer = setInterval(() => {
    try {
      // Reclaim stale active rows FIRST so freshly-interrupted rows are eligible
      // for failure-bucket eviction in the same tick.
      reclaimStaleActiveRows()
      runReaperOnce(successLimit, failureLimit)
    } catch (err: unknown) {
      consola.warn("[history/sqlite] reaper tick failed", err)
    }
  }, intervalSeconds * 1000)
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    ;(timer as { unref: () => void }).unref()
  }
}

export function stopReaper(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
