import type { HistoryEntry } from "@/types"

/** Export a HistoryEntry as a downloadable JSON file */
export function downloadEntryAsJson(entry: HistoryEntry): void {
  const json = JSON.stringify(entry, null, 2)
  const blob = new Blob([json], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  const model = entry.response?.model || entry.request.model || "unknown"
  a.download = `${entry.id}_${model}.json`
  a.click()
  URL.revokeObjectURL(url)
}
