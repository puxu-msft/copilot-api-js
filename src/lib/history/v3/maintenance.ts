/**
 * V3 periodic DB-maintenance tick (History V2 removal Phase 4b, adopted from
 * the retired V2 reaper tick — `sqlite/reaper.ts`, deleted in Phase 3).
 *
 * V2's reaper tick did TWO very different jobs bundled into one interval:
 *   1. "Reclaim stale active rows" — status-flip housekeeping bound to V2's
 *      pending/executing/streaming row model. V3 has NO equivalent concept
 *      (`v3_operations` only ever stores terminal rows) — this job has no V3
 *      counterpart and is intentionally NOT reintroduced here.
 *   2. Pure DB maintenance (return freed pages to the OS / keep the WAL from
 *      ballooning / keep planner stats current) — job-agnostic to what's
 *      stored in the DB. This module adopts ONLY this half: `incrementalVacuum`
 *      + `checkpointWal` + `runOptimize`, unchanged, from `sqlite/connection.ts`
 *      (kept + exported through the V2 removal precisely so this tick could
 *      reuse them rather than re-implement identical PRAGMA sequences).
 *
 * Not config-exposed (mirrors the V2 reaper's own non-configurable interval
 * and the startup-VACUUM thresholds in connection.ts) — the default needs no
 * operator attention.
 */

import {
  //
  checkpointWal,
  getDatabase,
  incrementalVacuum,
  runOptimize,
} from "../sqlite/connection"

/** Default tick interval. Not config-exposed — see module doc. */
const DEFAULT_INTERVAL_SECONDS = 300

let timer: ReturnType<typeof setInterval> | null = null

/**
 * One full maintenance tick: reclaim freed pages incrementally, checkpoint the
 * WAL, then refresh planner stats. All three primitives are individually
 * never-throw (see connection.ts) — this function itself never throws either,
 * so a timer-driven call can never crash the process via an unhandled
 * exception in a bare `setInterval` callback.
 */
export function runV3MaintenanceTick(): void {
  const db = getDatabase()
  incrementalVacuum(db)
  checkpointWal(db)
  runOptimize(db)
}

/**
 * Start the periodic V3 maintenance tick. Idempotent — calling it again while
 * already running restarts the timer at the (possibly new) interval rather
 * than stacking a second one.
 */
export function startV3Maintenance(intervalSeconds: number = DEFAULT_INTERVAL_SECONDS): void {
  stopV3Maintenance()
  timer = setInterval(runV3MaintenanceTick, intervalSeconds * 1000)
  // Never let this background tick keep the process alive on its own — mirrors
  // every other best-effort interval in the codebase (e.g. the retired reaper).
  timer.unref()
}

/** Stop the periodic tick (idempotent — safe to call when not running). */
export function stopV3Maintenance(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** Test-only: is the maintenance timer currently armed? */
export function isV3MaintenanceRunningForTests(): boolean {
  return timer !== null
}
