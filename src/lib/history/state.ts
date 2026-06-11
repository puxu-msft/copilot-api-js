import { PATHS } from "~/lib/config/paths"
import {
  //
  onHistoryLimitChange,
  state,
} from "~/lib/state"

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

export const historyState = {
  get enabled(): boolean {
    return enabled
  },
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
  closeDatabase()
  enabled = false
}

export function setHistoryMaxEntries(): void {
  startReaper(state.historySuccessLimit, state.historyFailureLimit, state.historyReaperInterval)
}
