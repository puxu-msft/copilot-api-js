import { Hono } from "hono"

import {
  //
  handleDeleteEntries,
  handleDeleteSession,
  handleExport,
  handleGetConversations,
  handleGetEntries,
  handleGetEntry,
  handleGetLineage,
  handleGetSession,
  handleGetSessions,
  handleGetStats,
  handlePinEntry,
  handleUnpinEntry,
} from "./handler"

// Plain Hono (not OpenAPIHono): the /history/api/* handlers live in ./handler and
// return broad `ContentfulStatusCode` JSON responses (plain `c.json(data)`), which
// `.openapi()`'s strict literal-status RouteHandler rejects. Binding them would
// require rewriting 10 shared/tested handlers or type casts; their real consumer
// (the Vue UI) is already fully typed via `~backend/*` re-exports. So this sub-API
// is intentionally ABSENT from /openapi.json — see src/routes/openapi.ts.
export const historyRoutes = new Hono()

historyRoutes.get("/", (c) => c.redirect("/ui#/v/activity", 302))
historyRoutes.all("/", (c) => c.json({ error: "Not Found" }, 404))

/** API endpoints */
historyRoutes.get("/api/entries", handleGetEntries)
historyRoutes.get("/api/entries/:id", handleGetEntry)
historyRoutes.get("/api/entries/:id/lineage", handleGetLineage)
historyRoutes.post("/api/entries/:id/pin", handlePinEntry)
historyRoutes.post("/api/entries/:id/unpin", handleUnpinEntry)
historyRoutes.delete("/api/entries", handleDeleteEntries)
historyRoutes.get("/api/stats", handleGetStats)
historyRoutes.get("/api/export", handleExport)
historyRoutes.get("/api/conversations", handleGetConversations)

/** Session endpoints */
historyRoutes.get("/api/sessions", handleGetSessions)
historyRoutes.get("/api/sessions/:id", handleGetSession)
historyRoutes.delete("/api/sessions/:id", handleDeleteSession)
