import { Hono } from "hono"

import {
  handleDeleteEntries,
  handleDeleteSession,
  handleExport,
  handleGetEntries,
  handleGetEntry,
  handleGetSession,
  handleGetSessions,
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

// Session endpoints
historyRoutes.get("/api/sessions", handleGetSessions)
historyRoutes.get("/api/sessions/:id", handleGetSession)
historyRoutes.delete("/api/sessions/:id", handleDeleteSession)

// Web UI - serve HTML for the root path
historyRoutes.get("/", (c) => {
  return c.html(getHistoryUI())
})
