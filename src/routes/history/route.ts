import { Hono } from "hono"
import { existsSync } from "node:fs"
import { access, constants } from "node:fs/promises"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

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
import { getMimeType } from "./assets"

export const historyRoutes = new Hono()

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

// ============================================================================
// Web UI static assets
// ============================================================================

/**
 * Resolve a UI directory that exists at runtime.
 * In dev mode this file lives at src/routes/history/ — 3 levels below project root.
 * In bundled mode (dist/main.mjs) — 1 level below project root.
 */
function resolveUiDir(subpath: string): string {
  const candidates = [
    join(import.meta.dirname, "../../..", "ui", subpath), // dev: src/routes/history/ → root
    join(import.meta.dirname, "..", "ui", subpath), // bundled: dist/ → root
  ]
  return candidates.find((c) => existsSync(c)) ?? candidates[0]
}

/** Web UI dist directory */
const uiDir = resolveUiDir("history-v3/dist")

/** Serve Web UI index.html */
historyRoutes.get("/", async (c) => {
  try {
    await access(join(uiDir, "index.html"), constants.R_OK)
    const content = await readFile(join(uiDir, "index.html"), "utf8")
    return c.html(content)
  } catch {
    return c.notFound()
  }
})

/** Serve Web UI hashed assets (immutable caching) */
historyRoutes.get("/assets/*", async (c) => {
  // Extract the /assets/* portion — works regardless of mount path (/ui or /history)
  const assetsIdx = c.req.path.indexOf("/assets/")
  if (assetsIdx === -1) return c.notFound()
  const filePath = c.req.path.slice(assetsIdx)
  const fullPath = resolve(join(uiDir, filePath))
  if (!fullPath.startsWith(uiDir)) return c.notFound()
  try {
    await access(fullPath, constants.R_OK)
    const content = await readFile(fullPath)
    return new Response(content, {
      headers: {
        "Content-Type": getMimeType(filePath),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    })
  } catch {
    return c.notFound()
  }
})
