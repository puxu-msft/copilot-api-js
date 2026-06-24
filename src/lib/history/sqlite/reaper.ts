import consola from "consola"

import { getProcessIdentity } from "~/lib/process-identity"
import { state } from "~/lib/state"

import type { Database } from "./connection"

import {
  //
  checkpointWal,
  getDatabase,
  incrementalVacuum,
  runOptimize,
} from "./connection"

let timer: ReturnType<typeof setInterval> | null = null

/**
 * Optional JS-side callback run at the START of each reaper tick. The store layer
 * registers `retryPendingFinalizations` here to re-attempt history finalizations
 * that a transient SQLite error deferred — wired via a setter so the reaper (SQLite
 * layer) stays decoupled from the store layer (it only invokes an opaque callback).
 */
let tickHook: (() => void) | null = null

/** Register (or clear, with `null`) the per-tick drain callback. */
export function setReaperTickHook(fn: (() => void) | null): void {
  tickHook = fn
}

/**
 * SQL predicates partitioning entries_v2 into success / failure buckets.
 *
 * Only TERMINAL rows are bucketed. Active rows (pending/executing/streaming),
 * introduced by eager persistence, fall OUTSIDE both buckets so the reaper never
 * counts or evicts an in-progress request's head row. Their backstop is
 * `reclaimStaleActiveRows` (runtime) + startup orphan recovery, which flip a
 * stuck/dead row to `interrupted` (a failure-bucket terminal state).
 *
 * `AND pinned = 0` similarly excludes debug-pinned rows from BOTH buckets:
 * `evictBucket` reuses the same predicate for its COUNT and its DELETE subquery,
 * so a pinned row is neither counted toward the limit (never pushes an unpinned
 * row out) nor eligible for eviction. Pinning a row keeps its raw data forever.
 */
const FAILURE_WHERE = "status IN ('failed','aborted','interrupted') AND pinned = 0"
const SUCCESS_WHERE = "status = 'completed' AND pinned = 0"

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
  const where = `status IN (${placeholders}) AND pid = ? AND started_at < ?`
  // Count the matched rows directly rather than reading `.run().changes`: the
  // entries_fts AFTER-UPDATE trigger also writes (trigram rows), and bun:sqlite
  // folds those trigger-side writes into `changes`, which would inflate the
  // reclaim count. COUNT+UPDATE run in one transaction so the returned number is
  // exactly what was flipped (mirrors evictBucket avoiding `.changes` under
  // cascade/trigger fan-out).
  let reclaimed = 0
  const tx = db.transaction(() => {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM entries_v2 WHERE ${where}`).get(...ACTIVE_STATUSES, pid, cutoff) as { n: number }
    if (n > 0)
      // Backfill a failure reason (richest-data-flow) so the reclaimed row surfaces WHY in
      // the list view (responseError ← error_message); COALESCE keeps any real reason already set.
      db.prepare(
        `UPDATE entries_v2 SET status = 'interrupted', ended_at = COALESCE(ended_at, ?), error_message = COALESCE(error_message, 'request exceeded maximum age — reaped as stale') WHERE ${where}`,
      ).run(cutoff, ...ACTIVE_STATUSES, pid, cutoff)
    reclaimed = n
  })
  tx()
  if (reclaimed > 0) consola.info(`[history/sqlite] reaper reclaimed ${reclaimed} stale active row(s) → interrupted`)
  return reclaimed
}

/**
 * One full reaper tick: drain deferred finalizations → reclaim stale active rows
 * → evict overflow buckets → return freed pages → checkpoint the WAL. Exported so
 * it can be exercised directly in tests without waiting on the interval timer.
 */
export function runReaperTick(successLimit: number, failureLimit: number): void {
  const db = getDatabase()
  // Drain transiently-deferred history finalizations FIRST, so freshly-persisted
  // rows are counted/bucketed in the eviction pass this same tick.
  tickHook?.()
  // Reclaim stale active rows so freshly-interrupted rows are eligible for
  // failure-bucket eviction in the same tick.
  reclaimStaleActiveRows()
  runReaperOnce(successLimit, failureLimit)
  // Return the pages just freed by eviction to the OS (no-op unless
  // auto_vacuum=INCREMENTAL is in effect — see incrementalVacuum).
  incrementalVacuum(db)
  // Keep the WAL bounded so lock windows stay short (fewer SQLITE_BUSY for the
  // persist-guard to absorb).
  checkpointWal(db)
  // Refresh planner statistics incrementally so index choices track the table's
  // changing shape (cheap; re-ANALYZEs only tables that changed enough).
  runOptimize(db)
}

export function startReaper(successLimit: number, failureLimit: number, intervalSeconds: number): void {
  stopReaper()
  // Gate the periodic timer ONLY on the interval knob ("do periodic maintenance?"),
  // NOT on the retention limits. The tick now does more than eviction — it drains
  // deferred finalizations, returns freed pages, and checkpoints the WAL — all of
  // which must keep running even when a user sets both limits to 0 (= unlimited
  // retention). Eviction itself self-disables: `evictBucket` no-ops on limit<=0.
  // (Previously a `limits<=0` short-circuit also killed the timer, which coupled
  // the finalize-retry drain to the eviction config and made "unlimited retention"
  // silently force every transient finalize failure straight to a lossy tombstone.)
  if (intervalSeconds <= 0) return
  timer = setInterval(() => {
    try {
      runReaperTick(successLimit, failureLimit)
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

/**
 * Whether the periodic reaper timer is currently running. The store layer gates
 * transient-retain on this: if no reaper will ever tick (interval disabled, or
 * during shutdown after stopReaper), a deferred finalize would never be retried
 * and would leak — so the caller tombstones immediately instead of retaining.
 */
export function isReaperRunning(): boolean {
  return timer !== null
}
