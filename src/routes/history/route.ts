import { Hono } from "hono"

import {
  //
  handleArchiveCooldown,
  handleArchiveNow,
  handleExport,
  handleExportEntry,
  handleGetEntries,
  handleGetEntry,
  handleGetSessions,
  handleGetStats,
  handlePinEntry,
  handleSearch,
  handleSearchContains,
  handleUnpinEntry,
} from "./handler"

// Plain Hono (not OpenAPIHono): the /history/api/* handlers live in ./handler and
// return broad `ContentfulStatusCode` JSON responses (plain `c.json(data)`), which
// `.openapi()`'s strict literal-status RouteHandler rejects. Binding them would
// require rewriting 10 shared/tested handlers or type casts; their real consumer
// (the Vue UI) is already fully typed via `~backend/*` re-exports. So this sub-API
// is documented via `openAPIRegistry.registerPath` in src/routes/openapi-compat.ts
// (simple schemas, handlers untouched) rather than `.openapi()`-bound here.
export const historyRoutes = new Hono()

historyRoutes.get("/", (c) => c.redirect("/ui#/v/activity", 302))
historyRoutes.all("/", (c) => c.json({ error: "Not Found" }, 404))

/** API endpoints */
historyRoutes.get("/api/entries", handleGetEntries)
historyRoutes.get("/api/entries/:id", handleGetEntry)
historyRoutes.get("/api/entries/:id/export", handleExportEntry)
historyRoutes.post("/api/entries/:id/pin", handlePinEntry)
historyRoutes.post("/api/entries/:id/unpin", handleUnpinEntry)
// Product-facing delete surface removed (spec §3.6): "clear history" is now
// "archive now" (HOT→tier-1 move, never a delete). The delete SQL primitives
// stay as test-only internals; they are no longer HTTP-exposed.
historyRoutes.post("/api/archive-now", handleArchiveNow)
// Age-based on-demand cool-down: run the standard `> hot_days` HOT→tier-1 pass now
// (respects hot_days; distinct from archive-now which force-archives regardless of age).
historyRoutes.post("/api/archive-cooldown", handleArchiveCooldown)
historyRoutes.get("/api/stats", handleGetStats)
historyRoutes.get("/api/sessions", handleGetSessions)
historyRoutes.get("/api/export", handleExport)
// Dedicated full-text search (content-addressed index) + lazy hash→requests companion.
historyRoutes.get("/api/search", handleSearch)
historyRoutes.get("/api/search/contains", handleSearchContains)
