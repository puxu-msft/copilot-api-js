import { PATHS } from "~/lib/config/paths"
import { state } from "~/lib/state"

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
  startReaper(state.historyLimit, state.historyReaperInterval)
}

export function shutdownHistory(): void {
  stopReaper()
  closeDatabase()
  enabled = false
}

export function setHistoryMaxEntries(limit: number): void {
  startReaper(limit, state.historyReaperInterval)
}
