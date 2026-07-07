import type {
  //
  EntrySummary,
  HistoryEntry,
  HistoryResult,
  QueryOptions,
  SummaryResult,
} from "./types"

import { resolveResponseModel } from "./entry-view"
import {
  //
  getInFlight,
  listInFlight,
  toEntrySummary,
} from "./in-flight"
import { extractInboundSearchText } from "./normalize-message"
import {
  //
  getEntryById,
  queryEntries,
  querySummaries,
} from "./sqlite/read"
import { formatFromEndpoint } from "./sqlite/search-index-write"

function matchesFilters(entry: HistoryEntry, opts: QueryOptions): boolean {
  if (opts.sessionId && entry.sessionId !== opts.sessionId) return false
  if (opts.endpoint && entry.endpoint !== opts.endpoint) return false
  if (opts.from !== undefined && entry.startedAt < opts.from) return false
  if (opts.to !== undefined && entry.startedAt > opts.to) return false
  if (opts.model) {
    const needle = opts.model.toLowerCase()
    const req = entry.inboundRequest.model?.toLowerCase() ?? ""
    const res = resolveResponseModel(entry)?.toLowerCase() ?? ""
    if (!req.includes(needle) && !res.includes(needle)) return false
  }
  if (opts.success === true && entry.state !== "completed") return false
  if (opts.success === false && entry.state !== "failed") return false
  return true
}

/** Non-terminal lifecycle states — these are the entries the Live lane owns. */
const NON_TERMINAL_STATES = new Set<EntrySummary["state"]>(["pending", "executing", "streaming"])

/**
 * Whether a summary represents an active in-flight request (vs a terminal one).
 * `active` is the canonical flag the request lifecycle sets while streaming;
 * `state` is the belt-and-suspenders check for an eager-persisted `streaming`
 * SQLite head row (which reads back `active: false`). Used by `terminalOnly`.
 */
function isInFlightSummary(summary: EntrySummary): boolean {
  return summary.active === true || NON_TERMINAL_STATES.has(summary.state)
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
  if (opts.state && summary.state !== opts.state) return false
  if (opts.pid !== undefined && summary.pid !== opts.pid) return false
  // NOTE: the `search` needle is intentionally NOT matched here — for in-flight
  // (not-yet-indexed) entries it is scanned against the normalized message text
  // in `inFlightMatchesSearch` (full-text parity with the persisted index), not
  // against the summary's preview. The persisted list path filters `search` in
  // SQL (preview_text LIKE).
  return true
}

/**
 * In-flight full-text search: scan the active entry's inbound messages with the
 * SAME normalization projection the persisted index uses, so a streaming entry
 * matches identically to a finalized one. No needle → always matches.
 */
function inFlightMatchesSearch(entry: HistoryEntry, needle: string | undefined): boolean {
  if (!needle) return true
  const messages = entry.inboundRequest.messages ?? []
  if (messages.length === 0) return false
  const text = extractInboundSearchText(messages, formatFromEndpoint(entry.endpoint))
  return text.toLowerCase().includes(needle.toLowerCase())
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

  const inFlightMatches = listInFlight().filter((entry) => matchesFilters(entry, options) && inFlightMatchesSearch(entry, options.search))
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
  const { limit = 50, cursor, terminalOnly } = options

  const inFlightSummaries = listInFlight()
    .filter((entry) => inFlightMatchesSearch(entry, options.search))
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

  // terminalOnly: drop active in-flight rows so streaming requests stay out of
  // the History list (consumers like ui-v4 show them in a dedicated Live lane).
  // Source-agnostic by state — catches both the live in-flight map and any
  // eager-persisted `streaming` SQLite head row, and keeps terminal entries
  // regardless of which source they came from.
  const visible = terminalOnly ? merged.filter((summary) => !isInFlightSummary(summary)) : merged

  visible.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))

  const total = visible.length
  let startIdx = 0
  if (cursor) {
    const cursorIdx = visible.findIndex((entry) => entry.id === cursor)
    if (cursorIdx !== -1) startIdx = cursorIdx + 1
  }
  const entries = visible.slice(startIdx, startIdx + limit)
  const nextCursor = startIdx + limit < total ? (entries.at(-1)?.id ?? null) : null
  const prevCursor = startIdx > 0 ? (entries[0]?.id ?? null) : null

  return { entries, total, nextCursor, prevCursor }
}
