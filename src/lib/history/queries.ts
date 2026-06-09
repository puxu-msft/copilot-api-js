import type {
  //
  EntrySummary,
  HistoryEntry,
  HistoryResult,
  QueryOptions,
  SummaryResult,
} from "./types"

import {
  //
  getInFlight,
  listInFlight,
  toEntrySummary,
} from "./in-flight"
import {
  //
  getEntryById,
  queryEntries,
  querySummaries,
} from "./sqlite/read"

function matchesFilters(entry: HistoryEntry, opts: QueryOptions): boolean {
  if (opts.sessionId && entry.sessionId !== opts.sessionId) return false
  if (opts.endpoint && entry.endpoint !== opts.endpoint) return false
  if (opts.from !== undefined && entry.startedAt < opts.from) return false
  if (opts.to !== undefined && entry.startedAt > opts.to) return false
  if (opts.model) {
    const needle = opts.model.toLowerCase()
    const req = entry.inboundRequest.model?.toLowerCase() ?? ""
    const res = entry.outboundResponse?.model.toLowerCase() ?? ""
    if (!req.includes(needle) && !res.includes(needle)) return false
  }
  if (opts.success === true && entry.state !== "completed") return false
  if (opts.success === false && entry.state !== "failed") return false
  return true
}

function summaryMatchesFilters(summary: EntrySummary, opts: QueryOptions): boolean {
  if (opts.sessionId && summary.sessionId !== opts.sessionId) return false
  if (opts.endpoint && summary.endpoint !== opts.endpoint) return false
  if (opts.from !== undefined && summary.startedAt < opts.from) return false
  if (opts.to !== undefined && summary.startedAt > opts.to) return false
  if (opts.model) {
    const needle = opts.model.toLowerCase()
    const req = summary.requestModel?.toLowerCase() ?? ""
    const res = summary.responseModel?.toLowerCase() ?? ""
    if (!req.includes(needle) && !res.includes(needle)) return false
  }
  if (opts.success === true && summary.responseSuccess !== true) return false
  if (opts.success === false && summary.responseSuccess !== false) return false
  if (opts.search) {
    const needle = opts.search.toLowerCase()
    const preview = summary.previewText.toLowerCase()
    const searchText = summary.searchText.toLowerCase()
    if (!preview.includes(needle) && !searchText.includes(needle)) return false
  }
  return true
}

export function getEntry(id: string): HistoryEntry | undefined {
  return getInFlight(id) ?? getEntryById(id)
}

export function getSummary(id: string): EntrySummary | undefined {
  const inflight = getInFlight(id)
  if (inflight) return toEntrySummary(inflight)
  const persisted = getEntryById(id)
  return persisted ? toEntrySummary(persisted) : undefined
}

export function getHistory(options: QueryOptions = {}): HistoryResult {
  const { limit = 50 } = options

  const inFlightMatches = listInFlight().filter((entry) => matchesFilters(entry, options))
  const persisted = queryEntries({ ...options, limit: 1_000_000 })

  const seen = new Set<string>()
  const merged: Array<HistoryEntry> = []
  for (const entry of inFlightMatches) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id)
      merged.push(entry)
    }
  }
  for (const entry of persisted) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id)
      merged.push(entry)
    }
  }

  merged.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))

  const total = merged.length
  const entries = merged.slice(0, limit)

  return {
    entries,
    total,
    page: 1,
    limit,
    totalPages: Math.ceil(total / limit),
  }
}

export function getHistorySummaries(options: QueryOptions = {}): SummaryResult {
  const { limit = 50, cursor } = options

  const inFlightSummaries = listInFlight()
    .map((entry) => toEntrySummary(entry))
    .filter((summary) => summaryMatchesFilters(summary, options))
  // Fetch a larger slice from SQLite so cursor-based slicing works.
  const persistedSummaries = querySummaries({ ...options, limit: 1_000_000 })

  const seen = new Set<string>()
  const merged: Array<EntrySummary> = []
  for (const summary of inFlightSummaries) {
    if (!seen.has(summary.id)) {
      seen.add(summary.id)
      merged.push(summary)
    }
  }
  for (const summary of persistedSummaries) {
    if (!seen.has(summary.id)) {
      seen.add(summary.id)
      merged.push(summary)
    }
  }

  merged.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))

  const total = merged.length
  let startIdx = 0
  if (cursor) {
    const cursorIdx = merged.findIndex((entry) => entry.id === cursor)
    if (cursorIdx !== -1) startIdx = cursorIdx + 1
  }
  const entries = merged.slice(startIdx, startIdx + limit)
  const nextCursor = startIdx + limit < total ? (entries.at(-1)?.id ?? null) : null
  const prevCursor = startIdx > 0 ? (entries[0]?.id ?? null) : null

  return { entries, total, nextCursor, prevCursor }
}
