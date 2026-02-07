// Web UI HTML template for history viewer
// Serves the static HTML file from disk

import { readFile } from "node:fs/promises"
import { join } from "node:path"

const htmlPath = join(import.meta.dirname, "../../ui/history-v1/index.html")

export async function getHistoryUI(): Promise<string> {
  return readFile(htmlPath, "utf8")
}
