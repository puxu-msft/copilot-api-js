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
  runHistoryWrite,
  runHistoryWriteAsync,
} from "./persist-guard"
import { queryEntryCount } from "./sqlite/read"
import { getEntry } from "./queries"
import { setV3OperationPinned } from "./v3/store"
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
  setEntryPinned,
  upsertHeadRow,
} from "./sqlite/write"
import { historyState } from "./state"
import { getStats } from "./stats"

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
 * Max transient-failure retries before a terminal entry is degraded to a
 * tombstone and dropped from memory. Bounds the in-flight retention of an entry
 * whose full write keeps failing, so a persistently-unwritable entry cannot
 * accumulate across reaper ticks.
 */
const MAX_FINALIZE_RETRIES = 5

/** id → consecutive transient finalize-failure count (entries retained in-flight for reaper-tick retry). */
const finalizeRetries = new Map<string, number>()

/**
 * Ids currently inside an in-flight (async) finalize — the re-entrancy guard
 * (RFC history-finalize-async-offload I2). A finalize now spans `await`s
 * (libuv compression), so a reaper retry tick or a duplicate terminal event can
 * re-enter `finalizeEntry(id)` for the same id mid-flight; the guard makes the
 * second call a no-op rather than a double write / double removeInFlight.
 */
const finalizing = new Set<string>()

/**
 * Promises for in-flight async finalizes — drained by `drainPendingFinalizations`
 * BEFORE the DB is closed at shutdown (I4). This is the SELF-OWNED drain handle;
 * it does NOT rely on the observability bus (HistorySink only subscribes to
 * `request.*`, so its finalize promise never enters any `publishAndFlush` set).
 */
const pendingFinalizations = new Set<Promise<void>>()

/** The terminal (full) write — async (compresses on the libuv threadpool). Swappable for tests. */
type TerminalWriter = (entry: HistoryEntry) => Promise<void>
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
 * Await every in-flight async finalize. Loops until quiescent so a finalize that
 * is kicked DURING the drain (e.g. a request settling at shutdown) is also waited
 * on. Never rejects (each finalize swallows its own errors). Used by
 * `shutdownHistory` before `closeDatabase` (I4) and by tests.
 */
export async function drainPendingFinalizations(): Promise<void> {
  while (pendingFinalizations.size > 0) {
    await Promise.allSettled(pendingFinalizations)
  }
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
export async function finalizeEntry(id: string): Promise<void> {
  if (!historyState.enabled) return
  const entry = getInFlight(id)
  if (!entry) {
    finalizeRetries.delete(id)
    return
  }
  // I2: a finalize is already in flight for this id (reaper retry tick / a duplicate
  // terminal event landing during the async CPU phase) → no-op, and do NOT touch
  // finalizeRetries (the in-flight finalize owns the retain/retry decision).
  if (finalizing.has(id)) return
  finalizing.add(id)
  const p = doFinalizeEntry(id, entry)
  pendingFinalizations.add(p)
  try {
    await p
  } finally {
    // Clear the in-flight tracking set FIRST, then the re-entrancy guard LAST —
    // `doFinalizeEntry` has already done its removeInFlight / finalizeRetries.set
    // mutation by the time `p` settles, so releasing the guard here lets a later
    // reaper tick re-enter cleanly for a transient-retained entry (I2 ③).
    pendingFinalizations.delete(p)
    finalizing.delete(id)
  }
}

/**
 * The actual finalize work, run once per id (guarded by `finalizing`). Awaits the
 * async terminal write (libuv-offloaded compression + sync tx), then applies the
 * non-lossy outcome: success → removeInFlight; transient + reaper running → retain
 * for a later retry; permanent / exhausted / no-reaper → degraded tombstone. Never
 * throws (every write goes through the guard).
 */
async function doFinalizeEntry(id: string, entry: HistoryEntry): Promise<void> {
  const result = await runHistoryWriteAsync("finalize", () => terminalWriter(entry))
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
  // ONLY the small essential stages (client_request + the final upstream_response,
  // both held in memory) — skipping the bulk (sseEvents / per-attempt request
  // bodies) that most likely triggered the failure — so the row stays readable
  // (`assembleFullEntry` rebuilds clientRequest + the upstream response leg) and
  // the request content + error survive. If even that fails, fall back to a
  // head-only flip so status/model/error in the head columns still persist (the
  // read path floors a missing client_request leg so it never crashes consumers).
  finalizeRetries.delete(id)
  const tombstoneStages = extractStagePayloads(entry).filter((s) => s.stage === STAGE.clientRequest || s.stage === STAGE.upstreamResponse)
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
 * cannot accumulate. No-op when nothing is pending. Returns a promise so the
 * shutdown drain can await the kicked finalizes (I4); the reaper hook fires it
 * fire-and-forget (it never rejects).
 */
export async function retryPendingFinalizations(): Promise<void> {
  if (finalizeRetries.size === 0) return
  await Promise.allSettled([...finalizeRetries.keys()].map((id) => finalizeEntry(id)))
}

// Register the drain on every reaper tick. Done here (not in state.ts) so the
// reaper stays decoupled from the store layer — it invokes an opaque callback,
// and the store owns what that callback does. Safe at module load: the hook is
// just stored; the timer that calls it is started later by initHistory.
// Fire-and-forget: retryPendingFinalizations is async now but never rejects
// (every finalize swallows its own errors), so the tick doesn't await it.
setReaperTickHook(() => void retryPendingFinalizations())

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
 * Wipe ALL history (in-flight + every SQLite table). **Test-only internal
 * primitive** (spec §3.6): the HTTP delete surface is removed — this stays only
 * as the isolation-reset used by resetTestRuntime + integration tests. Logs
 * LOUDLY (a silent full wipe is indistinguishable from a persistence bug).
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

/**
 * Toggle the debug-pin flag on a persisted entry, then broadcast the refreshed
 * summary so connected WS clients reflect the new state. Returns whether the
 * entry exists. A pinned entry is exempt from reaper eviction AND retention
 * counting (see `setEntryPinned` + reaper SUCCESS_WHERE/FAILURE_WHERE), so its
 * raw data survives GC for debugging. No stats broadcast — pinning changes
 * neither the completed/failed counts nor token sums.
 */
export function setPinned(id: string, pinned: boolean): boolean {
  if (!historyState.enabled) return false
  const changed = setV3OperationPinned(id, pinned) || setEntryPinned(id, pinned)
  if (!changed) return false
  // The `pinned` column is authoritative, but an entry that is still in-flight
  // (eager-persisted yet un-finalized) is read in-flight-FIRST by `getEntry`.
  // Sync the in-flight copy so HTTP responses and the broadcast summary reflect
  // the new flag immediately — not only after the entry finalizes. No-op when the
  // entry is already terminal (no in-flight copy). The pin survives finalize
  // regardless: INSERT_ENTRY_SQL never writes the column (see setEntryPinned).
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
