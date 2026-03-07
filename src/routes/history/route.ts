import type { UpgradeWebSocket } from "hono/ws"
import type { Server as NodeHttpServer } from "node:http"

import consola from "consola"
import { Hono } from "hono"
import { existsSync } from "node:fs"
import { access, constants } from "node:fs/promises"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { addClient, removeClient } from "~/lib/history"

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

/**
 * Initialize WebSocket support for history real-time updates.
 * Registers the /ws route on historyRoutes using the appropriate WebSocket
 * adapter for the current runtime (hono/bun for Bun, @hono/node-ws for Node.js).
 *
 * @param rootApp - The root Hono app instance (needed by @hono/node-ws to match upgrade requests)
 * @returns An `injectWebSocket` function that must be called with the Node.js HTTP server
 * after the server is created. Returns `undefined` under Bun (no injection needed).
 */
export async function initHistoryWebSocket(rootApp: Hono): Promise<((server: NodeHttpServer) => void) | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let upgradeWs: UpgradeWebSocket<any>
  let injectFn: ((server: NodeHttpServer) => void) | undefined

  if (typeof globalThis.Bun !== "undefined") {
    // Bun runtime: use hono/bun adapter
    const { upgradeWebSocket } = await import("hono/bun")
    upgradeWs = upgradeWebSocket
  } else {
    // Node.js runtime: use @hono/node-ws adapter
    const { createNodeWebSocket } = await import("@hono/node-ws")
    const nodeWs = createNodeWebSocket({ app: rootApp })
    upgradeWs = nodeWs.upgradeWebSocket
    injectFn = (server: NodeHttpServer) => nodeWs.injectWebSocket(server)
  }

  // Register on the root app directly — historyRoutes sub-app has already been
  // mounted via app.route("/history", historyRoutes) at import time, so adding
  // routes to historyRoutes here won't be visible on the root app.
  rootApp.get(
    "/history/ws",
    upgradeWs(() => ({
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

  return injectFn
}

/**
 * Resolve a UI directory that exists at runtime.
 * In dev mode this file lives at src/routes/history/ — 3 levels below project root.
 * In bundled mode (dist/main.mjs) — 1 level below project root.
 * We try both and fall back to the first candidate.
 */
function resolveUiDir(subpath: string): string {
  const candidates = [
    join(import.meta.dirname, "../../..", "ui", subpath), // dev: src/routes/history/ → root
    join(import.meta.dirname, "..", "ui", subpath), // bundled: dist/ → root
  ]
  return candidates.find((c) => existsSync(c)) ?? candidates[0]
}

/** Static assets for legacy UI v1 */
const v1Dir = resolveUiDir("history-v1")

/** v1 root serves index.html directly */
historyRoutes.get("/v1", (c) => {
  return c.redirect("/history/v1/index.html")
})

/** v1 static assets (CSS, JS) - no caching for development */
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

/** Static assets and routes for Vue UI v3 */
const v3Dir = resolveUiDir("history-v3/dist")

historyRoutes.get("/v3", async (c) => {
  try {
    await access(join(v3Dir, "index.html"), constants.R_OK)
    const content = await readFile(join(v3Dir, "index.html"), "utf8")
    return c.html(content)
  } catch {
    return c.notFound()
  }
})

historyRoutes.get("/v3/assets/*", async (c) => {
  const filePath = c.req.path.replace("/history/v3", "")
  if (!filePath) return c.notFound()
  const fullPath = resolve(join(v3Dir, filePath))
  if (!fullPath.startsWith(v3Dir)) return c.notFound()
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

historyRoutes.get("/", (c) => {
  return c.redirect("/history/v1")
})

historyRoutes.get("/index.html", (c) => {
  return c.redirect("/history/")
})
