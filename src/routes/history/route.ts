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
} from "./handler"

export const historyRoutes = new Hono()

historyRoutes.all("/", (c) => c.json({ error: "Not Found" }, 404))

/** API endpoints */
historyRoutes.get("/api/entries", handleGetEntries)
historyRoutes.get("/api/entries/:id", handleGetEntry)
historyRoutes.delete("/api/entries", handleDeleteEntries)
historyRoutes.get("/api/stats", handleGetStats)
historyRoutes.get("/api/export", handleExport)

/** Session endpoints */
historyRoutes.get("/api/sessions", handleGetSessions)
historyRoutes.get("/api/sessions/:id", handleGetSession)
historyRoutes.delete("/api/sessions/:id", handleDeleteSession)
