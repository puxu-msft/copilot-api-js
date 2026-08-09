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
import { historyState } from "./state"
import { getStats } from "./stats"
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
 * Wipe the persisted store, when a test has supplied a way to do it.
 *
 * Since the Batch 2b cutover the main thread holds no write connection to the semantic database — the Worker owns it — so `clearV3Store()` cannot run here any more. That is not a gap to paper over: a main-thread wipe of the semantic artifact IS the second writer this migration exists to remove, and the HTTP delete surface it once served was already removed (spec §3.6). So production installs nothing and the store wipe simply does not exist outside tests, while `resetTestRuntime` installs one backed by the test fixture's own write connection.
 */
let wipeStore: (() => void) | undefined

export function setHistoryStoreWipeForTests(wipe: (() => void) | undefined): void {
  wipeStore = wipe
}

/**
 * Wipe ALL history (in-flight map + every V3 table). **Test-only internal
 * primitive** (spec §3.6): the HTTP delete surface is removed — this stays
 * only as the isolation-reset used by resetTestRuntime + integration tests.
 * Logs LOUDLY (a silent full wipe is indistinguishable from a persistence
 * bug). The persisted half runs through the injected `wipeStore` seam above;
 * with no seam installed this clears in-flight state only.
 */
export function clearHistory(): void {
  const inFlightCount = listInFlight().length
  clearInFlight()
  clearRecentModelOperationTerminalsForTests()
  // Disabled means the History subsystem has no persisted state and no active product event
  // surface. Do not touch an unopened DB and do not fabricate clear/stats notifications.
  if (!historyState.enabled) return
  try {
    wipeStore?.()
    consola.warn(`[history] CLEARED test store (${inFlightCount} in-flight entries); this primitive is test-only`)
  } catch (err: unknown) {
    consola.error("[history] failed to clear test sqlite entries", err)
  }
  publishHistoryCleared()
  publishStatsChanged()
}

/**
 * Raised by {@link setPinned} for as long as pinning has no writer.
 *
 * Pinning is a WRITE to `v3_operations.pinned`, and the Batch 2b cutover moved the semantic write connection into the Worker while the corresponding `set-pinned` RPC is not scheduled until Batch 6 (plan §Batch 6 RPC surface). Ruled by the user on 2026-08-09: rather than pull that RPC forward, the endpoint is explicitly unavailable for the intervening batches — the project carries no backward-compatibility burden and prefers a short, loud outage to a rushed protocol addition. The route turns this into a 503 that says so, instead of the bare "database not initialized" crash the raw call would produce. Delete this class together with the Batch 6 `set-pinned` cutover.
 */
export class HistoryPinUnavailableError extends Error {
  constructor() {
    super("History pinning is unavailable: the semantic write connection now lives in the History Worker, and the set-pinned RPC lands in the query-RPC cutover (Batch 6).")
    this.name = "HistoryPinUnavailableError"
  }
}

/**
 * Toggle the debug-pin flag on a persisted entry, then broadcast the refreshed
 * summary so connected WS clients reflect the new state. Returns whether the
 * V3 operation exists. The V3 `pinned` column is the only product pin state;
 * there is no legacy-row fallback. No stats broadcast — pinning changes neither
 * the completed/failed counts nor token sums.
 *
 * Currently always throws {@link HistoryPinUnavailableError} when History is enabled; see that class for why and for when it goes away.
 */
export function setPinned(id: string, pinned: boolean): boolean {
  if (!historyState.enabled) return false
  void id
  void pinned
  throw new HistoryPinUnavailableError()
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
