import type {
  //
  EntrySummary,
  HistoryEntry,
} from "./types"

import {
  //
  listInFlight,
  toEntrySummary,
} from "./in-flight"
import {
  //
  recordToEntrySummary,
  recordToHistoryEntry,
} from "./v3/projection"
import {
  //
  getRecentModelOperationDurability,
  listRecentModelOperationTerminals,
} from "./v3/terminal-bus"

export function listHistoryOverlaySummaries(): Array<EntrySummary> {
  const merged = new Map<string, EntrySummary>()
  for (const entry of listInFlight()) merged.set(entry.id, toEntrySummary(entry))
  for (const record of listRecentModelOperationTerminals()) {
    const operationId = record.identity.operationId
    if (merged.has(operationId)) continue
    const durability = getRecentModelOperationDurability(operationId)
    merged.set(operationId, { ...recordToEntrySummary(record), ...(durability ? { durability } : {}) })
  }
  return [...merged.values()]
}

export function listHistoryOverlayEntries(): Array<HistoryEntry> {
  const merged = new Map<string, HistoryEntry>()
  for (const entry of listInFlight()) merged.set(entry.id, entry)
  for (const record of listRecentModelOperationTerminals()) {
    const operationId = record.identity.operationId
    if (!merged.has(operationId)) merged.set(operationId, recordToHistoryEntry(record))
  }
  return [...merged.values()]
}
