import type { HistoryEntry } from "@/types"

import { ExportButton } from "@/components/detail/ExportButton"
import {
  //
  formatDuration,
  formatUsageTokens,
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
  const signal = statusSignal(entry.state ?? "")
  // The proxy failure verdict (unrepairable tool input, refusal, truncation, upstream error …) —
  // surfaced here so it's visible on EVERY detail tab, not buried in the Response tab's leg sections.
  const verdict = entry.failureReason ?? entry.outboundResponse?.error
  return (
    <div className="mono flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-[#1c1c22] px-3 py-1.5 text-[13px] text-[#cdb]">
      <span style={{ color: SIGNAL_COLOR[signal] }}>{entry.state ?? "—"}</span>
      <span className="text-[var(--color-primary)]">{entry.endpoint}</span>
      {entry.durationMs === undefined ? null : <span className="text-[#888]">{formatDuration(entry.durationMs)}</span>}
      {entry.attemptCount === undefined ? null : <span className="text-[#888]">{entry.attemptCount} att</span>}
      {tokens ?
        <span className="text-[#888]">{formatUsageTokens(tokens)} tok</span>
      : null}
      {signal === "fail" && verdict !== undefined ?
        <span
          className="truncate"
          title={verdict}
          style={{ color: SIGNAL_COLOR.fail, maxWidth: "48ch" }}
        >
          {verdict}
        </span>
      : null}
      <span className="ml-auto">
        <ExportButton entry={entry} />
      </span>
    </div>
  )
}
