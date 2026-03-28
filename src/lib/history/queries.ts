import { ensureSearchText, historyIndexes, historyState } from "./state"
import type { CursorResult, EntrySummary, HistoryEntry, HistoryResult, QueryOptions } from "./types"

export function getHistory(options: QueryOptions = {}): HistoryResult {
  const { cursor, limit = 50, model, endpoint, success, from, to, search, sessionId } = options

  let filtered = [...historyState.entries]

  if (sessionId) {
    filtered = filtered.filter((entry) => entry.sessionId === sessionId)
  }
  if (model) {
    const modelLower = model.toLowerCase()
    filtered = filtered.filter(
      (entry) =>
        entry.request.model?.toLowerCase().includes(modelLower)
        || entry.response?.model.toLowerCase().includes(modelLower),
    )
  }
  if (endpoint) {
    filtered = filtered.filter((entry) => entry.endpoint === endpoint)
  }
  if (success !== undefined) {
    filtered = filtered.filter((entry) => entry.response?.success === success)
  }
  if (from) {
    filtered = filtered.filter((entry) => entry.timestamp >= from)
  }
  if (to) {
    filtered = filtered.filter((entry) => entry.timestamp <= to)
  }
  if (search) {
    const searchLower = search.toLowerCase()
    filtered = filtered.filter((entry) => ensureSearchText(entry.id).includes(searchLower))
  }

  filtered.sort((a, b) => b.timestamp - a.timestamp)

  const total = filtered.length
  let startIdx = 0
  if (cursor) {
    const cursorIdx = filtered.findIndex((entry) => entry.id === cursor)
    if (cursorIdx !== -1) startIdx = cursorIdx + 1
  }

  const entries = filtered.slice(startIdx, startIdx + limit)
  return {
    entries,
    total,
    page: 1,
    limit,
    totalPages: Math.ceil(total / limit),
  }
}

export function getEntry(id: string): HistoryEntry | undefined {
  return historyIndexes.entryIndex.get(id) ?? historyState.entries.find((entry) => entry.id === id)
}

export function getSummary(id: string): EntrySummary | undefined {
  return historyIndexes.summaryIndex.get(id)
}

export function getHistorySummaries(options: QueryOptions = {}): CursorResult<EntrySummary> {
  const { cursor, limit = 50, direction = "older", model, endpoint, success, from, to, search, sessionId } = options

  let summaries = Array.from(historyIndexes.summaryIndex.values())

  if (sessionId) summaries = summaries.filter((summary) => summary.sessionId === sessionId)
  if (model) {
    const modelLower = model.toLowerCase()
    summaries = summaries.filter(
      (summary) =>
        summary.requestModel?.toLowerCase().includes(modelLower)
        || summary.responseModel?.toLowerCase().includes(modelLower),
    )
  }
  if (endpoint) summaries = summaries.filter((summary) => summary.endpoint === endpoint)
  if (success !== undefined) summaries = summaries.filter((summary) => summary.responseSuccess === success)
  if (from) summaries = summaries.filter((summary) => summary.timestamp >= from)
  if (to) summaries = summaries.filter((summary) => summary.timestamp <= to)

  if (search) {
    const needle = search.toLowerCase()
    summaries = summaries.filter((summary) => ensureSearchText(summary.id).includes(needle))
  }

  summaries.sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id))

  const total = summaries.length
  let startIdx = 0
  if (cursor) {
    const cursorIdx = summaries.findIndex((summary) => summary.id === cursor)
    if (cursorIdx !== -1) {
      startIdx = direction === "older" ? cursorIdx + 1 : Math.max(0, cursorIdx - limit)
    }
  }

  const entries = summaries.slice(startIdx, startIdx + limit)
  const nextCursor = startIdx + limit < total ? (entries.at(-1)?.id ?? null) : null
  const prevCursor = startIdx > 0 ? (entries[0]?.id ?? null) : null

  return { entries, total, nextCursor, prevCursor }
}
