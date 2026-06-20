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
import {
  //
  extractStagePayloads,
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
 */
export function finalizeEntry(id: string): void {
  if (!historyState.enabled) return
  const entry = getInFlight(id)
  if (!entry) return

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

  try {
    insertCompletedEntry(entry, digest)
  } catch (err: unknown) {
    consola.warn("[history] failed to persist completed entry", err)
  }
  removeInFlight(id)
  publishEntryUpdated(toEntrySummary(entry))
  publishStatsChanged()
}

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

export function clearHistory(): void {
  clearInFlight()
  if (historyState.enabled) {
    try {
      clearAllEntries()
    } catch (err: unknown) {
      consola.warn("[history] failed to clear sqlite entries", err)
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
