import consola from "consola"

import { getProcessIdentity } from "~/lib/process-identity"
import { state } from "~/lib/state"

import { ACTIVE_STATES } from "../lifecycle-state"
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

/** Active (non-terminal) statuses — reaper-exempt; reclaimed only via interrupted. Sourced from the
 *  single lifecycle-state primitive (`ACTIVE_STATES`) so this SQL binding can't drift from the JS
 *  partition used by history/queries.ts + the TUI. */
const ACTIVE_STATUSES = ACTIVE_STATES

/**
 * Retention limits are retained in the public signature during Phase 0 so config
 * reload callers remain source-compatible, but online maintenance never deletes
 * or moves terminal records. Capacity governance moves to V3 byte budgets and
 * explicit operator tooling; it is not a periodic model-operation mutation.
 */
export function runReaperOnce(_successLimit: number, _failureLimit: number): number {
  return 0
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
  // Count the matched rows directly rather than reading `.run().changes`: an
  // AFTER-write trigger/cascade can inflate `.changes`, which would inflate the
  // reclaim count. COUNT+UPDATE run in one transaction so the returned number is
  // exactly what was flipped (mirrors evictBucket avoiding `.changes` under
  // cascade fan-out).
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
 * One full maintenance tick: drain deferred finalizations → reclaim stale active
 * rows → return freed pages → checkpoint the WAL → optimize. Exported so
 * it can be exercised directly in tests without waiting on the interval timer.
 */
export function runReaperTick(successLimit: number, failureLimit: number): void {
  const db = getDatabase()
  // Kick the transiently-deferred finalize drain. Since finalize is async
  // (libuv-offloaded compression, RFC history-finalize-async-offload), the hook is
  // fire-and-forget — a re-attempted finalize persists on a later microtask, so its
  // row is counted/bucketed by the NEXT tick's eviction, not this one. Benign: a
  // one-tick delay in counting a freshly-persisted retry never evicts it early.
  tickHook?.()
  // Reclaim stale active rows without removing their terminal records. Independent of in-flight finalizes:
  // it flips PERSISTED rows by status only. A row mid async-finalize is still
  // `streaming` here and may be flipped to `interrupted`, but the finalize's
  // terminal head upsert overwrites it back to its real terminal state (I3 benign —
  // finalize always wins; no loss/corruption, only a transient blip).
  reclaimStaleActiveRows()
  runReaperOnce(successLimit, failureLimit)
  // Return already-free pages to the OS (no-op unless
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
  // NOT on the retired retention limits. The tick drains
  // deferred finalizations, returns freed pages, and checkpoints the WAL — all of
  // which must keep running regardless of compatibility limit values.
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
