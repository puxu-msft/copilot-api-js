import consola from "consola"

import type {
  //
  EntrySummary,
  HistoryEntry,
} from "./types"

import {
  //
  notifyEntryAdded,
  notifyEntryUpdated,
  notifyHistoryCleared,
  notifyStatsUpdated,
} from "../ws"
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
  extractStagePayloads,
  type StagePayload,
} from "./sqlite/serialize"
import {
  //
  clearAllEntries,
  insertCompletedEntry,
  upsertHeadRow,
  upsertStageRow,
} from "./sqlite/write"
import { historyState } from "./state"
import { getStats } from "./stats"

export function insertEntry(entry: HistoryEntry): void {
  if (!historyState.enabled) return

  putInFlight(entry)
  notifyEntryAdded(toEntrySummary(entry))
  notifyStatsUpdated(getStats())
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

  notifyEntryUpdated(toEntrySummary(merged))
  notifyStatsUpdated(getStats())
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
  try {
    insertCompletedEntry(entry)
  } catch (err: unknown) {
    consola.warn("[history] failed to persist completed entry", err)
  }
  removeInFlight(id)
  notifyEntryUpdated(toEntrySummary(entry))
  notifyStatsUpdated(getStats())
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
  try {
    upsertHeadRow(entry, entry.state, extractStagePayloads(entry))
  } catch (err: unknown) {
    consola.warn("[history] eager head persist failed", err)
  }
}

/** Incremental head-row status update (on each lifecycle transition). Best-effort. */
export function persistEntryStatus(id: string): void {
  if (!historyState.enabled) return
  const entry = getInFlight(id)
  if (!entry) return
  try {
    upsertHeadRow(entry, entry.state)
  } catch (err: unknown) {
    consola.warn("[history] head status persist failed", err)
  }
}

/** Incremental per-attempt stage persistence (head row must already exist). Best-effort. */
export function persistEntryStages(id: string, stages: Array<StagePayload>): void {
  if (!historyState.enabled || stages.length === 0) return
  try {
    for (const stage of stages) upsertStageRow(id, stage)
  } catch (err: unknown) {
    consola.warn("[history] stage persist failed", err)
  }
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
  notifyHistoryCleared()
  notifyStatsUpdated(getStats())
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
