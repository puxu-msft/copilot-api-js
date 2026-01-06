import { Hono } from "hono"

import {
  handleDeleteEntries,
  handleExport,
  handleGetEntries,
  handleGetEntry,
  handleGetStats,
} from "./api"
import { getHistoryUI } from "./ui"

export const historyRoutes = new Hono()

// API endpoints
historyRoutes.get("/api/entries", handleGetEntries)
historyRoutes.get("/api/entries/:id", handleGetEntry)
historyRoutes.delete("/api/entries", handleDeleteEntries)
historyRoutes.get("/api/stats", handleGetStats)
historyRoutes.get("/api/export", handleExport)

// Web UI - serve HTML for the root path
historyRoutes.get("/", (c) => {
  return c.html(getHistoryUI())
})
