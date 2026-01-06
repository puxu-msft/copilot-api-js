import type { Context } from "hono"

import {
  clearHistory,
  deleteSession,
  exportHistory,
  getEntry,
  getHistory,
  getSession,
  getSessionEntries,
  getSessions,
  getStats,
  isHistoryEnabled,
  type QueryOptions,
} from "~/lib/history"

export function handleGetEntries(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  const query = c.req.query()
  const options: QueryOptions = {
    page: query.page ? Number.parseInt(query.page, 10) : undefined,
    limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
    model: query.model || undefined,
    endpoint: query.endpoint as "anthropic" | "openai" | undefined,
    success: query.success ? query.success === "true" : undefined,
    from: query.from ? Number.parseInt(query.from, 10) : undefined,
    to: query.to ? Number.parseInt(query.to, 10) : undefined,
    search: query.search || undefined,
    sessionId: query.sessionId || undefined,
  }

  const result = getHistory(options)
  return c.json(result)
}

export function handleGetEntry(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  const id = c.req.param("id")
  const entry = getEntry(id)

  if (!entry) {
    return c.json({ error: "Entry not found" }, 404)
  }

  return c.json(entry)
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

// Session management endpoints
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
  const session = getSession(id)

  if (!session) {
    return c.json({ error: "Session not found" }, 404)
  }

  // Include entries in the session response
  const entries = getSessionEntries(id)

  return c.json({
    ...session,
    entries,
  })
}

export function handleDeleteSession(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  const id = c.req.param("id")
  const success = deleteSession(id)

  if (!success) {
    return c.json({ error: "Session not found" }, 404)
  }

  return c.json({ success: true, message: "Session deleted" })
}
