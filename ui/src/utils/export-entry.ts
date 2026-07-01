import type { HistoryEntry } from "@/types"

import { api } from "@/api/http"
import { useToast } from "@/composables/useToast"

/** Trigger a browser download of `blob` under `filename` via a transient anchor. */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Export a HistoryEntry as a zstd-compressed `.json.zst` download.
 *
 * The compressed bytes come from the backend (`GET /history/api/entries/:id/export`),
 * which serializes the CANONICAL richest form (`getEntry` → all stages, per-attempt
 * sseEvents, every header leg) and zstd-compresses it server-side. This keeps the
 * export authoritative and complete (independent of whatever the UI has loaded) and
 * avoids re-serializing multi-MB entries in the browser. Errors surface via a toast
 * rather than failing silently.
 */
export async function downloadEntryAsZst(entry: HistoryEntry): Promise<void> {
  const { show } = useToast()
  try {
    const blob = await api.fetchEntryExport(entry.id)
    const model = entry.outboundResponse?.model || entry.inboundRequest.model || "unknown"
    // Sanitize model to filename-safe chars (matches the backend Content-Disposition).
    triggerDownload(blob, `${entry.id}_${model.replaceAll(/[^\w.-]/g, "_")}.json.zst`)
  } catch (error) {
    show(`Export failed: ${error instanceof Error ? error.message : String(error)}`, "error")
  }
}
