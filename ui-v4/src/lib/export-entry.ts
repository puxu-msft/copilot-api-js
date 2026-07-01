import type { HistoryEntry } from "@/types"

import { api } from "@/lib/api"

/** Filename for a downloaded entry: `<id>_<model>.json.zst` (response model preferred; model sanitized to filename-safe chars). */
export function entryExportFilename(entry: HistoryEntry): string {
  const model = entry.outboundResponse?.model || entry.inboundRequest.model || "unknown"
  return `${entry.id}_${model.replaceAll(/[^\w.-]/g, "_")}.json.zst`
}

/** Trigger a browser download of `blob` under `filename` via a transient anchor. */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Download one HistoryEntry as a zstd-compressed `.json.zst`.
 *
 * The compressed bytes come from the backend (`GET /history/api/entries/:id/export`),
 * which serializes the CANONICAL richest form (`getEntry` → all stages, per-attempt
 * sseEvents, every header leg) and zstd-compresses it server-side. This keeps the
 * export authoritative and complete regardless of what the UI has loaded, and avoids
 * re-serializing multi-MB entries in the browser. Rejects on failure — callers show
 * their own UI feedback.
 */
export async function downloadEntryAsZst(entry: HistoryEntry): Promise<void> {
  const blob = await api.getBlob(`/history/api/entries/${entry.id}/export`)
  triggerDownload(blob, entryExportFilename(entry))
}
