import type { Context } from "hono"

import {
  //
  clearHistory,
  deleteSession,
  exportHistory,
  getEntry,
  getHistorySummaries,
  getStats,
  isHistoryEnabled,
  setPinned,
  type EndpointType,
  type QueryOptions,
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
    pid: query.pid ? Number.parseInt(query.pid, 10) : undefined,
  }

  const result = getHistorySummaries(options)
  return c.json(result)
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
