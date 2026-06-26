import type { Context } from "hono"

import {
  //
  clearHistory,
  deleteSession,
  exportHistory,
  getEntry,
  getHistorySummaries,
  getSessionSummaries,
  getStats,
  isHistoryEnabled,
  searchContains,
  searchHistory,
  setPinned,
  type EndpointType,
  type QueryOptions,
  type SearchSource,
} from "~/lib/history"

export function handleGetEntries(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  const query = c.req.query()
  const options: QueryOptions = {
    cursor: query.cursor || undefined,
    limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
    direction: query.direction ? (query.direction as "older" | "newer") : undefined,
    model: query.model || undefined,
    endpoint: query.endpoint as EndpointType | undefined,
    success: query.success ? query.success === "true" : undefined,
    state: (query.state as QueryOptions["state"]) || undefined,
    from: query.from ? Number.parseInt(query.from, 10) : undefined,
    to: query.to ? Number.parseInt(query.to, 10) : undefined,
    search: query.search || undefined,
    sessionId: query.sessionId || undefined,
    agentId: query.agentId || undefined,
    mainAgentOnly: query.mainAgentOnly === "true" ? true : undefined,
    pid: query.pid ? Number.parseInt(query.pid, 10) : undefined,
  }

  const result = getHistorySummaries(options)
  return c.json(result)
}

/**
 * GET /history/api/sessions — per-session aggregate view (GROUP BY session_id over
 * terminal entries_v2 rows). `?limit=N` caps the number of sessions returned
 * (defaults to the store's internal cap when absent). Returns `{ sessions: [...] }`.
 */
export function handleGetSessions(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  const limitRaw = c.req.query("limit")
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined
  return c.json({ sessions: getSessionSummaries(limit) })
}

export function handleGetEntry(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  const id = c.req.param("id")
  if (!id) {
    return c.json({ error: "Entry id is required" }, 400)
  }
  const entry = getEntry(id)

  if (!entry) {
    return c.json({ error: "Entry not found" }, 404)
  }

  return c.json(entry)
}

/**
 * POST /history/api/entries/:id/pin and .../unpin — toggle the debug-pin flag.
 *
 * A pinned entry is exempt from the AUTOMATIC reaper (never evicted, not counted
 * toward the retention limits), keeping its raw request/response data across GC
 * while debugging. It is NOT immortal: explicit `DELETE /api/sessions/:id` and
 * `DELETE /api/entries` (clear-all) still remove it — pin only blocks the
 * background reaper, not deliberate deletion. Returns the refreshed full entry
 * (richest form, so the caller sees `pinned` plus everything else without a
 * second round-trip). 404 if unknown.
 */
function setEntryPinState(c: Context, pinned: boolean) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }
  const id = c.req.param("id")
  if (!id) {
    return c.json({ error: "Entry id is required" }, 400)
  }
  if (!setPinned(id, pinned)) {
    return c.json({ error: "Entry not found" }, 404)
  }
  const entry = getEntry(id)
  if (!entry) {
    return c.json({ error: "Entry not found" }, 404)
  }
  return c.json(entry)
}

export function handlePinEntry(c: Context) {
  return setEntryPinState(c, true)
}

export function handleUnpinEntry(c: Context) {
  return setEntryPinState(c, false)
}

export function handleDeleteEntries(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  clearHistory()
  return c.json({ success: true, message: "History cleared" })
}

export function handleGetStats(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  const stats = getStats()
  return c.json(stats)
}

export function handleExport(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  const format = (c.req.query("format") || "json") as "json" | "csv"
  const data = exportHistory(format)

  if (format === "csv") {
    c.header("Content-Type", "text/csv")
    c.header("Content-Disposition", "attachment; filename=history.csv")
  } else {
    c.header("Content-Type", "application/json")
    c.header("Content-Disposition", "attachment; filename=history.json")
  }

  return c.body(data)
}

/** Session management endpoints */
export function handleDeleteSession(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  const id = c.req.param("id")
  if (!id) {
    return c.json({ error: "Session id is required" }, 400)
  }
  const success = deleteSession(id)

  if (!success) {
    return c.json({ error: "Session not found" }, 404)
  }

  return c.json({ success: true, message: "Session deleted" })
}

const SEARCH_SOURCES: ReadonlySet<SearchSource> = new Set<SearchSource>(["inbound", "rewrites-req", "rewrites-resp", "req-headers", "resp-headers"])

/**
 * GET /history/api/search — dedicated full-text search over the content-addressed
 * index. `?source=` selects one of the five facets (default `inbound`), `?q=` the
 * needle, plus the same structural filters as the list. While the backfill runs,
 * `inbound` results carry `{ partial: true, builtPct }`.
 */
export function handleSearch(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  const query = c.req.query()
  const source = (query.source || "inbound") as SearchSource
  if (!SEARCH_SOURCES.has(source)) {
    return c.json({ error: `Invalid source '${source}'. Expected one of: ${[...SEARCH_SOURCES].join(", ")}` }, 400)
  }

  const filters: QueryOptions = {
    model: query.model || undefined,
    endpoint: query.endpoint as EndpointType | undefined,
    success: query.success ? query.success === "true" : undefined,
    state: (query.state as QueryOptions["state"]) || undefined,
    from: query.from ? Number.parseInt(query.from, 10) : undefined,
    to: query.to ? Number.parseInt(query.to, 10) : undefined,
    sessionId: query.sessionId || undefined,
    agentId: query.agentId || undefined,
    mainAgentOnly: query.mainAgentOnly === "true" ? true : undefined,
    pid: query.pid ? Number.parseInt(query.pid, 10) : undefined,
  }

  const result = searchHistory({
    source,
    q: query.q || "",
    limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
    cursor: query.cursor || undefined,
    filters,
  })
  return c.json(result)
}

/**
 * GET /history/api/search/contains?hash= — lazy companion to the `inbound` search:
 * every request id that references a given message hash (can be hundreds, so it is
 * NOT inlined into the search result rows).
 */
export function handleSearchContains(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }
  const hash = c.req.query("hash")
  if (!hash) {
    return c.json({ error: "hash query parameter is required" }, 400)
  }
  return c.json({ hash, reqIds: searchContains(hash) })
}
