import type { ScopedPublisher } from "~/lib/observability"

import { PATHS } from "~/lib/config/paths"
import {
  //
  onHistoryRawCaptureChange,
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
  configureRawCapture,
  shutdownRawCapture,
} from "./raw/manager"
import {
  //
  closeDatabase,
  getDatabase,
  openDatabase,
} from "./sqlite/connection"
import {
  //
  drainV3Writer,
  enqueueModelOperation,
  recoverV3Journal,
  V3_SCHEMA_SQL,
} from "./v3/store"
import {
  //
  clearRecentModelOperationTerminalsForTests,
  drainModelOperationTerminalSubscribers,
  subscribeModelOperationTerminals,
} from "./v3/terminal-bus"

let enabled = false
let unsubscribeV3Terminal: (() => void) | undefined
let unsubscribeRawCapture: (() => void) | undefined
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
  clearRecentModelOperationTerminalsForTests()
  enabled = enable
  if (!enable) {
    unsubscribeV3Terminal?.()
    unsubscribeV3Terminal = undefined
    unsubscribeRawCapture?.()
    unsubscribeRawCapture = undefined
    shutdownRawCapture()
    closeDatabase()
    return
  }
  // `historyDbPath` is retained only as an injected test seam during the V3
  // cutover. Production config cannot set it; the default is a physically
  // separate V3 artifact, so opening History never mutates legacy history.db.
  const dbPath = state.historyDbPath || PATHS.HISTORY_V3_DB
  openDatabase(dbPath)
  getDatabase().exec(V3_SCHEMA_SQL)
  recoverV3Journal(getDatabase())
  unsubscribeV3Terminal?.()
  unsubscribeV3Terminal = subscribeModelOperationTerminals(enqueueModelOperation)
  unsubscribeRawCapture?.()
  unsubscribeRawCapture = onHistoryRawCaptureChange(() => {
    configureRawCapture({
      enabled: state.historyRawCaptureEnabled,
      dbPath: state.historyRawCaptureDbPath || PATHS.HISTORY_RAW_DB,
      maxObjectBytes: state.historyRawCaptureMaxObjectBytes,
    })
  })
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
  unsubscribeRawCapture?.()
  unsubscribeRawCapture = undefined
  // Signal the background backfills to stop BEFORE the DB closes (each saves its
  // cursor per batch and resumes on next start — a post-close prepare would throw).
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
  // Deferred terminal finalizations are already-accepted durability work, not
  // background maintenance. Give them one last bounded-by-entry retry, then
  // drain the resulting writes before closing the canonical History DB.
  await retryPendingFinalizations()
  await drainPendingFinalizations()
  // Keep the canonical terminal subscriber alive through request drain. Only
  // detach after no more requests can settle, then drain terminal work to disk.
  unsubscribeV3Terminal?.()
  unsubscribeV3Terminal = undefined
  await drainModelOperationTerminalSubscribers()
  await drainV3Writer()
  shutdownRawCapture()
  closeDatabase()
  enabled = false
}

/** History V3 does not run V2 backfills or migrate a legacy history database. */
export function startHistoryBackfills(): void {
  // Intentionally empty: V3 starts as a separate canonical store with no legacy migration.
}
