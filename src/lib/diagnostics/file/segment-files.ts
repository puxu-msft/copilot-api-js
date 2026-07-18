import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"

/** List regular per-process NDJSON segments belonging to one pino-roll base. */
export function listDiagnosticSegments(baseName: string): Array<string> {
  const directory = path.dirname(baseName)
  const artifactStem = path.basename(baseName, ".ndjson")
  const rolledName = new RegExp(`^${escapeRegExp(artifactStem)}\\.\\d{4}-\\d{2}-\\d{2}\\.\\d+\\.ndjson$`)
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name === `${artifactStem}.ndjson` || rolledName.test(entry.name)))
    .map((entry) => path.join(directory, entry.name))
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

export function collectCommittedSpoolDeliveries(directory: string, wanted: ReadonlySet<string>): Set<string> {
  const committed = new Set<string>()
  if (wanted.size === 0) return committed
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (committed.size === wanted.size) break
    if (!entry.isFile() || !/^copilot-api-\d+-\d+(?:\.\d{4}-\d{2}-\d{2}\.\d+)?\.ndjson$/.test(entry.name)) continue
    scanLines(path.join(directory, entry.name), (line) => {
      if (!line) return
      try {
        const parsed = JSON.parse(line) as {
          record?: {
            recordType?: string
            diagnostic?: { event?: string; message?: string }
            catalog?: { models?: unknown; timeUnixMs?: number; tokenBasedBilling?: boolean }
            parts?: { method?: string; path?: string }
            delivery?: { spoolId?: string; sequence?: number; digest?: string }
          }
        }
        const record = parsed.record
        const delivery = record?.delivery
        const { delivery: _delivery, ...payload } = record ?? {}
        const payloadDigest = createHash("sha256").update(JSON.stringify(payload)).digest("base64url")
        const payloadValid =
          (record?.recordType === "diagnostic" && typeof record.diagnostic?.event === "string" && typeof record.diagnostic.message === "string")
          || (record?.recordType === "request-line" && typeof record.parts?.method === "string" && typeof record.parts.path === "string")
          || (record?.recordType === "model-catalog"
            && Array.isArray(record.catalog?.models)
            && typeof record.catalog.timeUnixMs === "number"
            && typeof record.catalog.tokenBasedBilling === "boolean")
        if (
          payloadValid
          && typeof delivery?.spoolId === "string"
          && typeof delivery.sequence === "number"
          && typeof delivery.digest === "string"
          && delivery.digest === payloadDigest
        ) {
          const key = `${delivery.spoolId}:${delivery.sequence}:${delivery.digest}`
          if (wanted.has(key)) committed.add(key)
        }
      } catch {
        // A malformed long-term line is diagnosed by the file reader. It cannot
        // prove a delivery committed, so recovery conservatively replays it.
      }
    })
  }
  return committed
}

function scanLines(file: string, visit: (line: string) => void): void {
  const fd = fs.openSync(file, "r")
  const decoder = new StringDecoder("utf8")
  const chunk = Buffer.allocUnsafe(64 * 1024)
  let carry = ""
  try {
    while (true) {
      const bytes = fs.readSync(fd, chunk, 0, chunk.length, null)
      if (bytes === 0) break
      carry += decoder.write(chunk.subarray(0, bytes))
      let newline = carry.indexOf("\n")
      while (newline !== -1) {
        visit(carry.slice(0, newline))
        carry = carry.slice(newline + 1)
        newline = carry.indexOf("\n")
      }
    }
    carry += decoder.end()
    if (carry) visit(carry)
  } finally {
    fs.closeSync(fd)
  }
}
