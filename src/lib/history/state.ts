import { generateId } from "../utils"
import type { EntrySummary, HistoryEntry, HistoryState, HistoryStats, Session } from "./types"

export const historyState: HistoryState = {
  enabled: false,
  entries: [],
  sessions: new Map(),
  currentSessionId: "",
  maxEntries: 200,
}

export const historyIndexes = {
  entryIndex: new Map<string, HistoryEntry>(),
  summaryIndex: new Map<string, EntrySummary>(),
  sessionEntryCount: new Map<string, number>(),
  sessionModelsSet: new Map<string, Set<string>>(),
  sessionToolsSet: new Map<string, Set<string>>(),
}

export const historyStatsCache: {
  dirty: boolean
  stats: HistoryStats | null
} = {
  dirty: true,
  stats: null,
}

export function resetHistoryIndexes(): void {
  historyIndexes.entryIndex.clear()
  historyIndexes.summaryIndex.clear()
  historyIndexes.sessionEntryCount.clear()
  historyIndexes.sessionModelsSet.clear()
  historyIndexes.sessionToolsSet.clear()
}

export function invalidateHistoryStats(): void {
  historyStatsCache.dirty = true
  historyStatsCache.stats = null
}

export function initHistory(enabled: boolean, maxEntries: number): void {
  historyState.enabled = enabled
  historyState.maxEntries = maxEntries
  historyState.entries = []
  historyState.sessions = new Map()
  historyState.currentSessionId = enabled ? generateId() : ""
  resetHistoryIndexes()
  invalidateHistoryStats()
}

export function setHistoryMaxEntries(limit: number): void {
  historyState.maxEntries = limit
}

export function isHistoryEnabled(): boolean {
  return historyState.enabled
}

export function resetHistoryStateForClear(): void {
  historyState.entries = []
  historyState.sessions = new Map<string, Session>()
  historyState.currentSessionId = generateId()
  resetHistoryIndexes()
  invalidateHistoryStats()
}
