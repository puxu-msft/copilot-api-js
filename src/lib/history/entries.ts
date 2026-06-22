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
  removeInFlight,
  toEntrySummary,
  updateInFlight,
} from "./in-flight"
import {
  //
  computeLineageDigest,
  type LineageDigest,
} from "./lineage"
import { runHistoryWrite } from "./persist-guard"
import { queryEntryCount } from "./sqlite/read"
import {
  //
  isReaperRunning,
  setReaperTickHook,
} from "./sqlite/reaper"
import {
  //
  extractStagePayloads,
  STAGE,
  type StagePayload,
} from "./sqlite/serialize"
import {
  //
  clearAllEntries,
  insertCompletedEntry,
  upsertHeadRow,
} from "./sqlite/write"
import { historyState } from "./state"
import { getStats } from "./stats"

/**
 * Publish a `history.*` ObservabilityEvent via the publisher installed at
 * start.ts (`setHistoryPublisher(bus.scope("history"))`). When no publisher
 * is installed (tests that don't need WS broadcast), it's a no-op — the
 * SQLite write already happened by the time we reach this function.
 */
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

export function insertEntry(entry: HistoryEntry): void {
  if (!historyState.enabled) return

  putInFlight(entry)
  publishEntryAdded(toEntrySummary(entry))
  publishStatsChanged()
}

export function updateEntry(
  id: string,
  update: Partial<
    Pick<
      HistoryEntry,
      | "rawPath"
      | "sessionId"
      | "state"
      | "active"
      | "lastUpdatedAt"
      | "queueWaitMs"
      | "attemptCount"
      | "currentStrategy"
      | "inboundRequest"
      | "outboundResponse"
      | "inboundResponse"
      | "pipelineInfo"
      | "sseEvents"
      | "durationMs"
      | "startedAt"
      | "endedAt"
      | "effectiveRequest"
      | "outboundRequest"
      | "httpHeaders"
      | "attempts"
      | "transport"
      | "warningMessages"
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
 * Max transient-failure retries before a terminal entry is degraded to a
 * tombstone and dropped from memory. Bounds the in-flight retention of an entry
 * whose full write keeps failing, so a persistently-unwritable entry cannot
 * accumulate across reaper ticks.
 */
const MAX_FINALIZE_RETRIES = 5

/** id → consecutive transient finalize-failure count (entries retained in-flight for reaper-tick retry). */
const finalizeRetries = new Map<string, number>()

/** The terminal (full) write. Swappable for tests to exercise the failure paths. */
type TerminalWriter = (entry: HistoryEntry, digest?: LineageDigest) => void
let terminalWriter: TerminalWriter = insertCompletedEntry

/**
 * Test seam: inject a terminal writer (e.g. one that throws a SQLITE_BUSY /
 * permanent error) to exercise the non-lossy finalize paths. Pass `undefined`
 * to restore the production `insertCompletedEntry`. Mirrors the
 * `setHttp2SessionFactoryForTests` DI pattern (DI over `mock.module`).
 */
export function __setTerminalWriterForTests(fn?: TerminalWriter): void {
  terminalWriter = fn ?? insertCompletedEntry
}

/**
 * Finalize an in-flight entry: persist to SQLite and remove from the
 * in-flight map. Caller MUST have already merged the terminal state
 * (state="completed"|"failed", response, etc.) via `updateEntry` before
 * calling this.
 *
 * Why this is separate from `updateEntry`:
 *   Previously updateEntry inferred terminality from `merged.state` and
 *   auto-finalized as a side effect. That coupled the state field's
 *   semantic to a write-to-disk action, so any earlier patch that happened
 *   to include `state: "completed"` (e.g. a `state_changed` handler running
 *   BEFORE the `completed` event delivered the full response) would persist
 *   an incomplete entry and then `removeInFlight` it — the later "full"
 *   update would silently no-op because the entry was gone. Making
 *   finalization an explicit call eliminates this whole class of ordering
 *   bugs and makes the flow auditable.
 *
 * Non-lossy on write failure (the core of the persist-resilience fix): the
 * in-flight copy is the last surviving source of the entry, so it is dropped
 * ONLY after a confirmed write. A transient failure (SQLITE_BUSY) with a running
 * reaper retains the entry for a reaper-tick retry; a permanent failure,
 * exhausted retries, or no running reaper degrades to a readable tombstone (head
 * + the small inbound_request/outbound_response stages) so the FACT of the
 * request is never lost.
 */
export function finalizeEntry(id: string): void {
  if (!historyState.enabled) return
  const entry = getInFlight(id)
  if (!entry) {
    finalizeRetries.delete(id)
    return
  }

  // Compute the lineage digest OUTSIDE the transaction (RFC §11). A throw
  // here logs + persists the entry without a lineage row — the backfill
  // script can recover it later. The check below tolerates the "this entry
  // is not an Anthropic request" / "this entry has no messages" cases via
  // computeLineageDigest returning null.
  let digest: LineageDigest | undefined
  try {
    digest = computeLineageDigest(entry) ?? undefined
  } catch (err: unknown) {
    consola.warn("[lineage] digest compute failed for", id, err)
  }

  const result = runHistoryWrite("finalize", () => terminalWriter(entry, digest))
  if (result.ok) {
    finalizeRetries.delete(id)
    removeInFlight(id)
    publishEntryUpdated(toEntrySummary(entry))
    publishStatsChanged()
    return
  }

  // Persisting the full entry failed. NEVER blind-`removeInFlight` here — that
  // was the silent total-loss (disk write failed AND the only memory copy
  // dropped → the request vanished from history, only a warn left behind).
  const attempts = (finalizeRetries.get(id) ?? 0) + 1
  if (result.transient && attempts < MAX_FINALIZE_RETRIES && isReaperRunning()) {
    // Transient (e.g. SQLITE_BUSY under WAL contention) AND a reaper tick will
    // come to retry: retain the in-flight copy untouched. The `isReaperRunning`
    // gate is essential — with the reaper disabled (interval 0) or stopped (mid
    // shutdown) there is no drain, so retaining would leak forever; we tombstone
    // immediately instead (below).
    finalizeRetries.set(id, attempts)
    return
  }

  // Permanent error, transient retries exhausted, or no reaper to retry:
  // preserve the FACT of the request as a degraded tombstone. Write head +
  // ONLY the small essential stages (inbound_request + outbound_response, both
  // held in memory) — skipping the bulk (sseEvents / per-attempt request bodies)
  // that most likely triggered the failure — so the row stays readable
  // (`assembleFullEntry` rebuilds inboundRequest/outboundResponse) and the
  // request content + error survive. If even that fails, fall back to a head-only
  // flip so status/model/error in the head columns still persist (the read path
  // floors a missing inbound_request stage so it never crashes consumers).
  finalizeRetries.delete(id)
  const tombstoneStages = extractStagePayloads(entry).filter((s) => s.stage === STAGE.inboundRequest || s.stage === STAGE.outboundResponse)
  const tomb = runHistoryWrite("finalize-tombstone", () => upsertHeadRow(entry, entry.state, tombstoneStages))
  if (!tomb.ok) {
    const headOnly = runHistoryWrite("finalize-tombstone-head", () => upsertHeadRow(entry, entry.state))
    if (!headOnly.ok) consola.error(`[history] tombstone write failed entirely; entry ${id} not persisted`)
  }
  removeInFlight(id)
  publishEntryUpdated(toEntrySummary(entry))
  publishStatsChanged()
}

/**
 * Reaper-tick drain: re-attempt finalize for entries whose terminal write failed
 * transiently and were retained in-flight. Each retry runs the full finalize path
 * (success → persisted + removed; still-failing → re-queued, or past
 * MAX_FINALIZE_RETRIES → tombstoned + dropped), so a permanently-unwritable entry
 * cannot accumulate. No-op when nothing is pending.
 */
export function retryPendingFinalizations(): void {
  if (finalizeRetries.size === 0) return
  for (const id of finalizeRetries.keys()) finalizeEntry(id)
}

// Register the drain on every reaper tick. Done here (not in state.ts) so the
// reaper stays decoupled from the store layer — it invokes an opaque callback,
// and the store owns what that callback does. Safe at module load: the hook is
// just stored; the timer that calls it is started later by initHistory.
setReaperTickHook(retryPendingFinalizations)

/**
 * Eager incremental persistence: write the head row (+ whatever stage rows are
 * available, typically inbound_request) at request START, in one transaction so
 * the head exists before any stage row (FK). This is what makes a SIGKILL /
 * crash leave a discoverable SQLite row (status=pending) instead of nothing.
 * Best-effort: a persistence error must never break request handling.
 */
export function persistEntryEager(entry: HistoryEntry): void {
  if (!historyState.enabled) return
  runHistoryWrite("eager-head", () => upsertHeadRow(entry, entry.state, extractStagePayloads(entry)))
}

/** Incremental head-row status update (on each lifecycle transition). Best-effort. */
export function persistEntryStatus(id: string): void {
  if (!historyState.enabled) return
  const entry = getInFlight(id)
  if (!entry) return
  runHistoryWrite("head-status", () => upsertHeadRow(entry, entry.state))
}

/**
 * Incremental per-attempt stage persistence. Head-first / FK-safe: upserts the
 * in-flight head row + these stages in ONE transaction, so a not-yet-persisted
 * head can never `FOREIGN KEY constraint failed`-reject the stage rows (the
 * historic silently-swallowed failure). Replaces the bare per-stage
 * `upsertStageRow` loop, which assumed the head already existed. Best-effort.
 */
export function persistEntryStages(id: string, stages: Array<StagePayload>): void {
  if (!historyState.enabled || stages.length === 0) return
  const entry = getInFlight(id)
  if (!entry) return
  runHistoryWrite("stage", () => upsertHeadRow(entry, entry.state, stages))
}

/**
 * Wipe ALL history (in-flight + every SQLite table). Triggered by
 * `DELETE /history/api/entries` (the UI's "clear all"). This is a destructive,
 * irreversible operation, so it logs LOUDLY with the count it removed — a silent
 * full wipe is invisible in the logs and indistinguishable from a persistence
 * bug (it cost a long forensic investigation to attribute one lost failed entry
 * to a clear rather than a finalize/reaper defect).
 */
export function clearHistory(): void {
  const inFlightCount = listInFlight().length
  clearInFlight()
  if (historyState.enabled) {
    let persistedCount = 0
    try {
      persistedCount = queryEntryCount()
    } catch {
      /* count is best-effort, purely for the log line */
    }
    try {
      clearAllEntries()
      consola.warn(`[history] CLEARED ALL entries (${persistedCount} persisted + ${inFlightCount} in-flight) via DELETE /api/entries`)
    } catch (err: unknown) {
      consola.error("[history] failed to clear sqlite entries", err)
    }
  }
  publishHistoryCleared()
  publishStatsChanged()
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
