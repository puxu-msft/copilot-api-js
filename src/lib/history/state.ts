import type { ScopedPublisher } from "~/lib/observability"

import { PATHS } from "~/lib/config/paths"
import {
  //
  onHistoryLimitChange,
  state,
} from "~/lib/state"

// Function-only cyclic import (state ↔ entries): used solely inside
// `shutdownHistory` at call time, never at module eval, so it is safe — by then
// both modules are fully initialized (entries' `retryPendingFinalizations` is a
// hoisted function declaration).
import { retryPendingFinalizations } from "./entries"
import { clearInFlight } from "./in-flight"
import {
  //
  closeDatabase,
  openDatabase,
} from "./sqlite/connection"
import {
  //
  startReaper,
  stopReaper,
} from "./sqlite/reaper"

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

export function shutdownHistory(): void {
  unsubscribeHistoryLimit?.()
  unsubscribeHistoryLimit = undefined
  stopReaper()
  // Last-chance drain BEFORE closing the DB: the reaper is now stopped, so each
  // still-pending deferred finalize that fails again will tombstone (its
  // `isReaperRunning()` gate is now false) instead of re-retaining — nothing
  // transiently-deferred is silently lost on graceful shutdown.
  retryPendingFinalizations()
  closeDatabase()
  enabled = false
}

export function setHistoryMaxEntries(): void {
  startReaper(state.historySuccessLimit, state.historyFailureLimit, state.historyReaperInterval)
}
