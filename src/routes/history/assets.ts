// Static assets for History UI v2
// Serves built Vue app from disk

import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { access, constants } from "node:fs/promises"
import { join } from "node:path"

const distPath = join(import.meta.dirname, "ui-v2/dist")

// Check if dist exists at startup (sync is fine for one-time init)
const isBuilt = existsSync(distPath)

// Cache loaded assets
const assetCache = new Map<string, { content: Buffer; contentType: string }>()

function getMimeType(path: string): string {
  if (path.endsWith(".html")) return "text/html"
  if (path.endsWith(".js")) return "application/javascript"
  if (path.endsWith(".css")) return "text/css"
  if (path.endsWith(".json")) return "application/json"
  if (path.endsWith(".svg")) return "image/svg+xml"
  if (path.endsWith(".png")) return "image/png"
  if (path.endsWith(".ico")) return "image/x-icon"
  return "application/octet-stream"
}

export async function getAsset(path: string): Promise<{ content: Buffer; contentType: string } | null> {
  if (!isBuilt) return null

  // Normalize path
  let assetPath = path
  if (assetPath === "/" || assetPath === "") {
    assetPath = "/index.html"
  }

  // Check cache
  const cached = assetCache.get(assetPath)
  if (cached) {
    return cached
  }

  // Load from disk
  const fullPath = join(distPath, assetPath)
  try {
    await access(fullPath, constants.R_OK)
    const content = await readFile(fullPath)
    const contentType = getMimeType(assetPath)
    const result = { content, contentType }
    assetCache.set(assetPath, result)
    return result
  } catch {
    return null
  }
}

export function isV2Available(): boolean {
  return isBuilt
}
