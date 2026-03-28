/**
 * Live log endpoint — recent EntrySummary snapshot for the log viewer page.
 *
 * Returns the most recent entries (newest first, capped at `limit`).
 * After initial load, the web client subscribes to /ws
 * WebSocket for real-time `entry_added` / `entry_updated` events.
 */

import { Hono } from "hono"

import { getHistorySummaries, isHistoryEnabled } from "~/lib/history"

export const logsRoutes = new Hono()

logsRoutes.get("/", (c) => {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  const limit = Math.min(Number(c.req.query("limit")) || 100, 500)
  const result = getHistorySummaries({ limit })

  return c.json({
    entries: result.entries,
    total: result.total,
  })
})
