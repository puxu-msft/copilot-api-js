import consola from "consola"
import { Hono } from "hono"
import { access, constants } from "node:fs/promises"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { addClient, removeClient } from "~/lib/history-ws"

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
import { getAsset, getMimeType } from "./assets"

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

// WebSocket endpoint for real-time updates (Bun only)
// hono/bun requires the Bun global; dynamic import prevents crash on Node.js
if (typeof globalThis.Bun !== "undefined") {
  const { upgradeWebSocket } = await import("hono/bun")
  historyRoutes.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        addClient(ws.raw as unknown as WebSocket)
      },
      onClose(_event, ws) {
        removeClient(ws.raw as unknown as WebSocket)
      },
      onMessage(_event, _ws) {
        // Currently we don't process messages from clients
      },
      onError(event, ws) {
        consola.debug("WebSocket error:", event)
        removeClient(ws.raw as unknown as WebSocket)
      },
    })),
  )
}

// Static assets for Vue UI v2
historyRoutes.get("/assets/*", async (c) => {
  const path = c.req.path.replace("/history", "")
  const asset = await getAsset(path)
  if (!asset) {
    return c.notFound()
  }
  return new Response(asset.content, {
    headers: {
      "Content-Type": asset.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  })
})

// Static assets for legacy UI v1
const v1Dir = join(import.meta.dirname, "../../ui/history-v1")

// v1 root serves index.html directly
historyRoutes.get("/v1", (c) => {
  return c.redirect("/history/v1/index.html")
})

// v1 static assets (CSS, JS) - no caching for development
historyRoutes.get("/v1/*", async (c) => {
  const filePath = c.req.path.replace("/history/v1", "")
  if (!filePath) return c.notFound()
  const fullPath = resolve(join(v1Dir, filePath))
  // Prevent path traversal
  if (!fullPath.startsWith(v1Dir)) return c.notFound()
  try {
    await access(fullPath, constants.R_OK)
  } catch {
    return c.notFound()
  }
  const content = await readFile(fullPath, "utf8")
  return new Response(content, {
    headers: {
      "Content-Type": getMimeType(filePath),
      "Cache-Control": "no-cache",
    },
  })
})

// v2 root serves Vue app index.html
historyRoutes.get("/v2", async (c) => {
  const html = await getAsset("/index.html")
  if (!html) {
    return c.notFound()
  }
  return c.html(html.content.toString())
})

historyRoutes.get("/", (c) => {
  // if (isV2Available()) {
  //   return c.redirect("/history/v2")
  // }
  return c.redirect("/history/v1")
})

historyRoutes.get("/index.html", (c) => {
  return c.redirect("/history/")
})
