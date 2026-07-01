import { useState } from "react"

import type { HistoryEntry } from "@/types"

import { downloadEntryAsZst } from "@/lib/export-entry"

type ExportState = "idle" | "busy" | "error"

const BTN_BASE = "mono border border-[var(--color-border)] px-2 py-0.5 text-[12px]"

const LABEL: Record<ExportState, string> = { idle: "Export .zst", busy: "Exporting…", error: "Export failed" }
const COLOR: Record<ExportState, string> = { idle: "text-[var(--color-primary)]", busy: "text-[var(--color-primary)]", error: "text-[var(--color-fail)]" }

/**
 * Download the full entry as a zstd-compressed `.json.zst`. Errors surface inline on
 * the button (no toast system in ui-v4) and auto-reset after a moment.
 */
export function ExportButton({ entry }: { entry: HistoryEntry }) {
  const [state, setState] = useState<ExportState>("idle")

  async function onExport() {
    if (state === "busy") return
    setState("busy")
    try {
      await downloadEntryAsZst(entry)
      setState("idle")
    } catch {
      setState("error")
      setTimeout(() => setState("idle"), 4000)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void onExport()}
      disabled={state === "busy"}
      title="Download the full request/response lifecycle as a zstd-compressed JSON (.json.zst)"
      className={`${BTN_BASE} ${COLOR[state]}`}
    >
      {LABEL[state]}
    </button>
  )
}
