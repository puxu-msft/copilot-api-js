import consola from "consola"

import type {
  //
  EntrySummary,
  HistoryEntry,
} from "./types"

import {
  //
  clearInFlight,
  getInFlight,
  listInFlight,
  putInFlight,
  toEntrySummary,
  updateInFlight,
} from "./in-flight"
import { getEntry } from "./queries"
import { historyState } from "./state"
import { getStats } from "./stats"
import {
  //
  clearAllV3ForTests,
  setV3OperationPinned,
} from "./v3/store"
import { clearRecentModelOperationTerminalsForTests } from "./v3/terminal-bus"

/** Publish after persistence through the scoped history observability channel. */
function publishEntryAdded(summary: EntrySummary): void {
  historyState.publisher?.publish({ kind: "history.entry_added", summary })
}
function publishEntryUpdated(summary: EntrySummary): void {
  historyState.publisher?.publish({ kind: "history.entry_updated", summary })
}
function publishStatsChanged(): void {
  historyState.publisher?.publish({ kind: "history.stats_changed", stats: getStats() })
}
function publishHistoryCleared(): void {
  historyState.publisher?.publish({ kind: "history.cleared" })
}

/**
 * Insert an entry into the in-flight map. In production this is only reached
 * via a test seam (History V3 removed the V2 write chain — `HistorySink` was
 * its sole production caller, and `HistorySink` was tests-only, see History
 * V2 removal Phase 1/3). Kept as the in-flight-injection primitive tests use
 * to seed entries readable through `getEntry`/`getHistory` (which merge the
 * in-flight map with V3-persisted terminal records, see `queries.ts`).
 */
export function insertEntry(entry: HistoryEntry): void {
  if (!historyState.enabled) return

  putInFlight(entry)
  publishEntryAdded(toEntrySummary(entry))
  publishStatsChanged()
}

/**
 * Patch an in-flight entry and broadcast the refreshed summary. Same
 * production-dead / test-live status as `insertEntry` above — the sole
 * caller was the deleted `HistorySink`.
 */
export function updateEntry(
  id: string,
  update: Partial<
    Pick<
      HistoryEntry,
      | "rawPath"
      | "sessionId"
      | "agentId"
      | "state"
      | "active"
      | "lastUpdatedAt"
      | "queueWaitMs"
      // New client leg (RFC §2.1) — dual-written by the history sink at terminal.
      // The per-attempt new legs (effectiveSource/upstreamRequest/upstreamResponse)
      // ride through the whole-object "attempts" field below, so they need no
      // separate allowlist entry.
      | "clientResponse"
      // New parent/leg/projection fields (RFC §3) — dual-written by the sink at the
      // eager insert (model.requested + clientRequest) and completed at terminal
      // (model.resolved/multiplier + full clientRequest + _index.derived + preprocessing).
      // Three-point sync for _index.derived: toHistoryEntry + onTerminal projection + HERE.
      | "model"
      | "clientRequest"
      | "preprocessing"
      | "_index"
      | "pipelineInfo"
      | "durationMs"
      | "startedAt"
      | "endedAt"
      | "attempts"
      | "transport"
      | "warningMessages"
      | "multiplier"
      // 首包埋点（spec 2026-07-14 §3.2）：client 3 刻 nested timing — dual-written by the sink
      // at terminal (onTerminal projection → HERE → finalizeEntry → buildHeadRow → 列). plan M-B.
      | "timing"
    >
  >,
): void {
  if (!historyState.enabled) return

  const merged = updateInFlight(id, update)
  if (!merged) return

  publishEntryUpdated(toEntrySummary(merged))
  publishStatsChanged()
}

/**
 * Wipe ALL history (in-flight map + every V3 table). **Test-only internal
 * primitive** (spec §3.6): the HTTP delete surface is removed — this stays
 * only as the isolation-reset used by resetTestRuntime + integration tests.
 * Logs LOUDLY (a silent full wipe is indistinguishable from a persistence
 * bug). `clearAllV3ForTests` replaces the deleted V2 `clearAllEntries`
 * (History V2 removal Phase 3) as the persisted-store wipe primitive.
 */
export function clearHistory(): void {
  const inFlightCount = listInFlight().length
  clearInFlight()
  clearRecentModelOperationTerminalsForTests()
  if (historyState.enabled) {
    try {
      clearAllV3ForTests()
      consola.warn(`[history] CLEARED test store (${inFlightCount} in-flight entries); this primitive is test-only`)
    } catch (err: unknown) {
      consola.error("[history] failed to clear test sqlite entries", err)
    }
  }
  publishHistoryCleared()
  publishStatsChanged()
}

/**
 * Toggle the debug-pin flag on a persisted entry, then broadcast the refreshed
 * summary so connected WS clients reflect the new state. Returns whether the
 * V3 operation exists. The V3 `pinned` column is the only product pin state;
 * there is no legacy-row fallback. No stats broadcast — pinning changes neither
 * the completed/failed counts nor token sums.
 */
export function setPinned(id: string, pinned: boolean): boolean {
  if (!historyState.enabled) return false
  const changed = setV3OperationPinned(id, pinned)
  if (!changed) return false
  // Sync a same-id in-flight copy defensively so broadcasts and immediate reads
  // agree with the V3 column. A normal V3 pin targets a terminal operation and
  // therefore has no in-flight twin.
  updateInFlight(id, { pinned })
  const entry = getInFlight(id) ?? getEntry(id)
  if (entry) publishEntryUpdated(toEntrySummary(entry))
  return true
}

export function listInFlightEntries(): Array<HistoryEntry> {
  return listInFlight()
}

export function listInFlightSummaries(): Array<EntrySummary> {
  return listInFlight().map((entry) => toEntrySummary(entry))
}

export function getInFlightEntry(id: string): HistoryEntry | undefined {
  return getInFlight(id)
}
