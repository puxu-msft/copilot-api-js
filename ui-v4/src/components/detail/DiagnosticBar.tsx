import type { HistoryEntry } from "@/types"

import {
  //
  formatDuration,
  statusSignal,
  type Signal,
} from "@/lib/format"

const SIGNAL_COLOR: Record<Signal, string> = {
  ok: "var(--color-ok)",
  fail: "var(--color-fail)",
  warn: "var(--color-warn)",
  live: "var(--color-ok)",
  muted: "var(--color-muted)",
}

export function DiagnosticBar({ entry }: { entry: HistoryEntry }) {
  const tokens = entry.outboundResponse?.usage
  return (
    <div className="mono flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-[#1c1c22] px-3 py-1.5 text-[13px] text-[#cdb]">
      <span style={{ color: SIGNAL_COLOR[statusSignal(entry.state ?? "")] }}>{entry.state ?? "—"}</span>
      <span className="text-[var(--color-primary)]">{entry.endpoint}</span>
      {entry.durationMs === undefined ? null : <span className="text-[#888]">{formatDuration(entry.durationMs)}</span>}
      {entry.attemptCount === undefined ? null : <span className="text-[#888]">{entry.attemptCount} att</span>}
      {tokens ?
        <span className="text-[#888]">
          ↑{tokens.input_tokens} ↓{tokens.output_tokens} tok
        </span>
      : null}
    </div>
  )
}
