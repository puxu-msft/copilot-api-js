import consola from "consola"

import type { ScopedPublisher } from "~/lib/observability"

import { PATHS } from "~/lib/config/paths"
import {
  //
  onHistoryLimitChange,
  state,
} from "~/lib/state"

// Function-only cyclic import (state ↔ entries): used solely inside
// `shutdownHistory` at call time, never at module eval, so it is safe — by then
// both modules are fully initialized (these are hoisted function declarations).
import {
  //
  drainPendingFinalizations,
  retryPendingFinalizations,
} from "./entries"
import { clearInFlight } from "./in-flight"
import {
  //
  runCalibrationBackfill,
  stopCalibrationBackfill,
} from "./sqlite/calibration-backfill"
import {
  //
  closeDatabase,
  getDatabase,
  isDatabaseOpen,
  openDatabase,
} from "./sqlite/connection"
import {
  //
  runLegacyStageBackfill,
  stopLegacyStageBackfill,
} from "./sqlite/legacy-stage-backfill"
import {
  //
  runCacheWriteBackfill,
  stopCacheWriteBackfill,
} from "./sqlite/cache-write-backfill"
import {
  //
  startReaper,
  stopReaper,
} from "./sqlite/reaper"
import {
  //
  runResponsePreviewBackfill,
  stopResponsePreviewBackfill,
} from "./sqlite/response-preview-backfill"
import {
  //
  runSearchIndexBackfill,
  stopSearchIndexBackfill,
} from "./sqlite/search-index-backfill"
import {
  //
  runUsageNormalizeBackfill,
  stopUsageNormalizeBackfill,
} from "./sqlite/usage-normalize-backfill"

let enabled = false
let unsubscribeHistoryLimit: (() => void) | undefined
let _publisher: ScopedPublisher<"history"> | undefined

export const historyState = {
  get enabled(): boolean {
    return enabled
  },
  /**
   * Scoped publisher for `history.*` events. Set once at start.ts via
   * `setHistoryPublisher`. Read by entries.ts / sessions.ts to publish
   * `history.entry_added/updated/stats_changed/cleared/session_deleted`
   * after every SQLite write. Undefined in test runs that don't set it —
   * write paths then silently skip the publish step (the WS broadcast is
   * a sink concern, not a correctness concern).
   */
  get publisher(): ScopedPublisher<"history"> | undefined {
    return _publisher
  },
}

/**
 * Install the bus publisher used by the history subsystem to emit
 * `history.*` events. Called once at `start.ts` after `initBus()`.
 * Tests that need WS broadcast behavior call this themselves; tests
 * that only need persistence can leave it unset.
 */
export function setHistoryPublisher(publisher: ScopedPublisher<"history"> | undefined): void {
  _publisher = publisher
}

export function isHistoryEnabled(): boolean {
  return enabled
}

export function initHistory(enable: boolean, _legacyMaxEntries?: number): void {
  clearInFlight()
  enabled = enable
  if (!enable) return
  const dbPath = state.historyDbPath || PATHS.HISTORY_DB
  openDatabase(dbPath)
  startReaper(state.historySuccessLimit, state.historyFailureLimit, state.historyReaperInterval)
  // Subscribe to live limit changes from config hot-reload.
  // `onHistoryLimitChange` invokes the listener synchronously once with the
  // current value, so we don't miss any reset that happened before this point.
  unsubscribeHistoryLimit?.()
  unsubscribeHistoryLimit = onHistoryLimitChange(setHistoryMaxEntries)
}

/**
 * Stop history BACKGROUND work WITHOUT closing the DB (graceful Phase 1).
 *
 * The DB must stay open through Phase 2/3 request drain: a request completing
 * during drain triggers an ASYNC finalize (RFC history-finalize-async-offload),
 * which writes to the DB after this point. Closing here (the pre-refactor
 * behavior) would make every such finalize hit a dead handle and lose the entry
 * (§4.1 CRITICAL). The DB is closed later by `shutdownHistory`, invoked from the
 * shutdown `finalize()` step AFTER drain.
 *
 * Stops the reaper + backfill so no new background writes start, but leaves
 * `enabled` true so in-flight finalizes still persist.
 */
export function stopHistoryBackgroundWork(): void {
  unsubscribeHistoryLimit?.()
  unsubscribeHistoryLimit = undefined
  stopReaper()
  // Signal the background backfills to stop BEFORE the DB closes (each saves its
  // cursor per batch and resumes on next start — a post-close prepare would throw).
  stopUsageNormalizeBackfill()
  stopLegacyStageBackfill()
  stopCacheWriteBackfill()
  stopSearchIndexBackfill()
  stopResponsePreviewBackfill()
  stopCalibrationBackfill()
}

/**
 * Final history teardown (graceful `finalize()` step, AFTER request drain): await
 * every in-flight async finalize, run a last-chance retry for transient-deferred
 * entries (the reaper is stopped, so a re-failure tombstones instead of leaking),
 * drain once more in case the retry kicked new finalizes, THEN close the DB. This
 * is the I4 drain that makes async finalize lossless at shutdown. Async; awaited
 * by the shutdown sequence before process exit.
 */
export async function shutdownHistory(): Promise<void> {
  // Idempotent: a direct call (tests / non-graceful paths) must also stop background work.
  stopHistoryBackgroundWork()
  await drainPendingFinalizations()
  await retryPendingFinalizations()
  await drainPendingFinalizations()
  closeDatabase()
  enabled = false
}

export function setHistoryMaxEntries(): void {
  startReaper(state.historySuccessLimit, state.historyFailureLimit, state.historyReaperInterval)
}

/**
 * Fire-and-forget the recoverable search_index + preview backfill in the
 * BACKGROUND. Called once from start.ts AFTER the server is listening so it never
 * blocks startup — `runSearchIndexBackfill` is async/chunked/resumable and yields
 * between batches. No-op when history is disabled / the DB is not open. Returns
 * immediately; the work trickles in the background and never throws (it catches
 * internally; this `.catch` is a belt-and-suspenders guard against an
 * unhandledRejection crashing the process).
 */
export function startSearchIndexBackfill(): void {
  if (!enabled || !isDatabaseOpen()) return
  void runSearchIndexBackfill(getDatabase())
    .catch((err: unknown) => consola.warn("[history] search-index backfill failed", err))
    .finally(() => startResponsePreviewBackfill())
}

/**
 * Fire-and-forget the recoverable response-preview backfill in the BACKGROUND —
 * the heaviest link, run AFTER the search-index backfill, THEN chains the final
 * calibration seed backfill. Fills
 * `response_preview_text` for pre-feature rows (NULL column) by reassembling each
 * entry and extracting its preview. No-op when history is disabled / the DB is not
 * open. `runResponsePreviewBackfill` catches internally; the `.catch`/`.finally`
 * here are belt-and-suspenders against an unhandledRejection crashing the process.
 */
export function startResponsePreviewBackfill(): void {
  if (!enabled || !isDatabaseOpen()) return
  void runResponsePreviewBackfill(getDatabase())
    .catch((err: unknown) => consola.warn("[history] response-preview backfill failed", err))
    .finally(() => startCalibrationBackfill())
}

/**
 * Fire-and-forget the recoverable calibration seed backfill in the BACKGROUND —
 * the FINAL link of the chain. Pairs each completed anthropic-messages row's real
 * prompt tokens with its recomputed local estimate and seed-calibrates the
 * size-aware factor model (cold-start bootstrap, spec §6). No-op when history is
 * disabled / the DB is not open. `runCalibrationBackfill` catches internally; this
 * `.catch` is a belt-and-suspenders guard against an unhandledRejection crashing
 * the process.
 */
export function startCalibrationBackfill(): void {
  if (!enabled || !isDatabaseOpen()) return
  void runCalibrationBackfill(getDatabase()).catch((err: unknown) => consola.warn("[history] calibration backfill failed", err))
}

/**
 * Fire-and-forget the recoverable legacy-stage → client/upstream-stage migration
 * in the BACKGROUND, THEN chain the heavier search-index backfill. Runs AFTER
 * usage-normalize completes (the migration defers on usage-normalize's version
 * flag — see legacy-stage-backfill.ts). No-op when history is disabled / the DB is
 * not open. `runLegacyStageBackfill` catches internally; the `.catch`/`.finally`
 * here are belt-and-suspenders against an unhandledRejection crashing the process.
 */
export function startLegacyStageBackfill(): void {
  if (!enabled || !isDatabaseOpen()) return
  void runLegacyStageBackfill(getDatabase())
    .catch((err: unknown) => consola.warn("[history] legacy-stage backfill failed", err))
    .finally(() => startCacheWriteBackfill())
}

/**
 * Backfill `cache_creation` (from GHC cache_write) for historical STREAMING
 * OpenAI-family rows. Chained AFTER legacy-stage (needs the new upstream_response
 * stage layout) and BEFORE search-index. It recomputes the whole usage split from
 * the raw sse_events frames (never re-subtracts the already-net column — C2). No-op
 * when history is disabled / the DB is not open; catches internally.
 */
export function startCacheWriteBackfill(): void {
  if (!enabled || !isDatabaseOpen()) return
  void runCacheWriteBackfill(getDatabase())
    .catch((err: unknown) => consola.warn("[history] cache-write backfill failed", err))
    .finally(() => startSearchIndexBackfill())
}

/**
 * Fire-and-forget the background backfills, serialized: usage net-of-cache
 * normalization (fast — small blobs, guarded by usage_normalized) runs FIRST, then
 * the legacy-stage → client/upstream-stage migration (which depends on usage being
 * netted first), then the heavier search-index + preview backfill. Called once from
 * start.ts AFTER the server is listening so it never blocks startup. No-op when
 * history is disabled / the DB is not open. Every run catches internally; the
 * `.catch`/`.finally` here are belt-and-suspenders against an unhandledRejection
 * crashing the process.
 */
export function startHistoryBackfills(): void {
  if (!enabled || !isDatabaseOpen()) return
  void runUsageNormalizeBackfill(getDatabase())
    .catch((err: unknown) => consola.warn("[history] usage-normalize backfill failed", err))
    .finally(() => startLegacyStageBackfill())
}
