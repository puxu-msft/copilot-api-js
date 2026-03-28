import { Hono } from "hono"
import type { Context } from "hono"
import { existsSync } from "node:fs"
import { access, constants, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { getMimeType } from "../history/assets"

export const uiRoutes = new Hono()

/**
 * Resolve a UI directory that exists at runtime.
 * In dev mode this file lives at src/routes/ui/ — 3 levels below project root.
 * In bundled mode (dist/main.mjs) — 1 level below project root.
 */
function resolveUiDir(subpath: string): string {
  const candidates = [
    join(import.meta.dirname, "../../..", "ui", subpath),
    join(import.meta.dirname, "..", "ui", subpath),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

const uiDir = resolveUiDir("history-v3/dist")

async function serveIndexHtml(c: Context) {
  try {
    await access(join(uiDir, "index.html"), constants.R_OK)
    const content = await readFile(join(uiDir, "index.html"), "utf8")
    return c.html(content)
  } catch {
    return c.notFound()
  }
}

async function serveAsset(c: Context) {
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
}

uiRoutes.get("/", serveIndexHtml)
uiRoutes.get("/assets/*", serveAsset)
