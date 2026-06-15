import type { Context } from "hono"

import {
  //
  clearHistory,
  deleteSession,
  exportHistory,
  getEntry,
  getHistorySummaries,
  getSession,
  getSessionEntries,
  getSessions,
  getStats,
  isHistoryEnabled,
  type EndpointType,
  type QueryOptions,
} from "~/lib/history"
import { getLineage } from "~/lib/history/lineage"

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
 * GET /history/api/entries/:id/lineage — return the lineage neighborhood
 * for one entry: parent, children, siblings, root-cluster summary.
 *
 * Returns `{ digest: null, parent: null, children: [], siblings: [], rootSummary: null }`
 * (with HTTP 200) when the entry exists but has no lineage row — typical
 * for non-Anthropic entries (v1 scope per RFC §8.1) or entries written
 * before backfill. Returns 404 when the entry itself is unknown.
 */
export function handleGetLineage(c: Context) {
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
  return c.json(getLineage(id))
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
export function handleGetSessions(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  const result = getSessions()
  return c.json(result)
}

export function handleGetSession(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  const id = c.req.param("id")
  if (!id) {
    return c.json({ error: "Session id is required" }, 400)
  }
  const session = getSession(id)

  if (!session) {
    return c.json({ error: "Session not found" }, 404)
  }

  // Include paginated entries in the session response
  const query = c.req.query()
  const result = getSessionEntries(id, {
    cursor: query.cursor || undefined,
    limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
  })

  return c.json({
    ...session,
    ...result,
  })
}

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
