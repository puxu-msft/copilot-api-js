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
  clearAllEntries,
  insertCompletedEntry,
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
      | "request"
      | "response"
      | "pipelineInfo"
      | "sseEvents"
      | "durationMs"
      | "startedAt"
      | "endedAt"
      | "effectiveRequest"
      | "wireRequest"
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
