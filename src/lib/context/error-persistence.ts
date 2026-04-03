/**
 * Error persistence consumer.
 *
 * Subscribes to "failed" events on RequestContext and writes structured
 * error files to disk for post-mortem debugging. All data comes from
 * RequestContext (via HistoryEntryData on the event), not from Hono
 * Context — ensuring reliability regardless of whether the HTTP body
 * has been consumed.
 *
 * Output directory: PATHS.ERROR_DIR/{timestamp}_{id}/
 * Files:
 *   - meta.json:       structured metadata (timestamp, endpoint, model, error, attempts)
 *   - request.json:    full request payload (messages capped at 50 for size)
 *   - effective-request.json: logical request after sanitize/truncate/retry
 *   - wire-request.json: final outbound HTTP payload + headers sent upstream
 *   - response.txt:    raw upstream response body (if available)
 *   - sse-events.json: recorded SSE events (if streaming request failed mid-stream)
 */

import consola from "consola"
import { randomBytes } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { PATHS } from "~/lib/config/paths"

import type { RequestContextEvent } from "./manager"
import type { HistoryEntryData } from "./request"

// ============================================================================
// Consumer entry point
// ============================================================================

/** Handle context events — only acts on "failed" */
export function handleErrorPersistence(event: RequestContextEvent): void {
  if (event.type !== "failed") return

  writeErrorEntry(event.entry).catch((err: unknown) => {
    consola.debug(`[ErrorPersistence] Failed to write error file: ${String(err)}`)
  })
}

// ============================================================================
// File writing
// ============================================================================

/** Max number of messages to include in request.json (to avoid huge files) */
const MAX_MESSAGES_IN_DUMP = 50

async function writeErrorEntry(entry: HistoryEntryData): Promise<void> {
  // Build compact meta (focused on debugging, not full replay)
  const meta = {
    timestamp: new Date(entry.startedAt).toISOString(),
    startedAt: new Date(entry.startedAt).toISOString(),
    endedAt: new Date(entry.endedAt).toISOString(),
    id: entry.id,
    endpoint: entry.endpoint,
    durationMs: entry.durationMs,
    request: {
      model: entry.request.model,
      stream: entry.request.stream,
      messageCount: entry.request.messages?.length,
      toolCount: entry.request.tools?.length,
    },
    effective: entry.effectiveRequest
      ? { model: entry.effectiveRequest.model, messageCount: entry.effectiveRequest.messageCount }
      : undefined,
    wire: entry.wireRequest
      ? { model: entry.wireRequest.model, messageCount: entry.wireRequest.messageCount }
      : undefined,
    response:
      entry.response ?
        {
          success: entry.response.success,
          model: entry.response.model,
          error: entry.response.error,
          status: entry.response.status,
        }
      : undefined,
    truncation: entry.truncation,
    attempts: entry.attempts,
  }

  // Collect file entries: [filename, content] pairs
  const files: Array<[string, string]> = [["meta.json", JSON.stringify(meta, null, 2)]]

  // Full request payload (from RequestContext — always available)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: request may not be set in all failure paths
  if (entry.request) {
    const { messages, ...requestWithoutMessages } = entry.request
    const requestData = {
      ...requestWithoutMessages,
      messageCount: messages?.length,
      // Include messages only for small payloads to avoid huge files
      ...(messages && messages.length <= MAX_MESSAGES_IN_DUMP && { messages }),
    }
    files.push(["request.json", JSON.stringify(requestData, null, 2)])
  }

  // Raw upstream response body (from HTTPError.responseText, preserved in ResponseData)
  if (entry.response?.responseText) {
    files.push(["response.txt", entry.response.responseText])
  }

  // SSE events (useful for diagnosing mid-stream failures)
  if (entry.sseEvents?.length) {
    files.push(["sse-events.json", JSON.stringify(entry.sseEvents, null, 2)])
  }

  // Effective request: logical payload after sanitize/truncate/retry, before
  // client-specific final wire mutations (beta headers, context_management injection, etc.).
  if (entry.effectiveRequest) {
    files.push([
      "effective-request.json",
      JSON.stringify(entry.effectiveRequest.payload ?? entry.effectiveRequest, null, 2),
    ])
  }

  // Wire request: final outbound HTTP payload and headers. This is the
  // authoritative source for post-mortems when the client mutates the payload
  // after the pipeline has already recorded effectiveRequest.
  if (entry.wireRequest) {
    files.push(["wire-request.json", JSON.stringify(entry.wireRequest, null, 2)])
  }

  // Create directory and write all files (only after all data is collected)
  const id = randomBytes(4).toString("hex")
  const dirPath = path.join(PATHS.ERROR_DIR, `${formatTimestamp()}_${id}`)

  await fs.mkdir(dirPath, { recursive: true })
  await Promise.all(files.map(([name, content]) => fs.writeFile(path.join(dirPath, name), content)))
}

// ============================================================================
// Helpers
// ============================================================================

/** Format timestamp as YYMMDD_HHmmss for error directory names */
function formatTimestamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const YY = String(now.getFullYear()).slice(2)
  return `${YY}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}
