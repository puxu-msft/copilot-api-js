import {
  //
  resolveAttemptCount,
  resolveResponseError,
  resolveResponseUsage,
} from "~backend/lib/history/entry-view"

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
  ok: "var(--signal-ok)",
  fail: "var(--signal-fail)",
  warn: "var(--signal-warn)",
  live: "var(--signal-ok)",
  muted: "var(--signal-muted)",
}

export function DiagnosticBar({ entry }: { entry: HistoryEntry }) {
  // New legs (`_index.derived` / final attempt `upstreamResponse`); legacy top-level legs removed in P4c.
  const tokens = resolveResponseUsage(entry)
  const attemptCount = resolveAttemptCount(entry)
  const signal = statusSignal(entry.state ?? "")
  // The proxy failure verdict (unrepairable tool input, refusal, truncation, upstream error …) —
  // surfaced here so it's visible on EVERY detail tab, not buried in the Response tab's leg sections.
  const verdict = entry._index?.derived?.failureReason ?? resolveResponseError(entry)
  const timingSource = entry.timing?.operation?.source
  const approximateDuration = timingSource === "storage-commit-upper-bound" || timingSource === "terminal-log-rounded"
  let approximateDurationTitle: string | undefined
  if (timingSource === "storage-commit-upper-bound") approximateDurationTitle = "历史记录仅保留持久化提交时间；该时长是真实终态时长的上界"
  else if (timingSource === "terminal-log-rounded") approximateDurationTitle = "该时长从终端舍入日志恢复，精度受日志显示限制"
  return (
    <div className="mono flex flex-wrap items-center gap-2 border-b border-[var(--surface-border)] bg-[var(--surface-diagnostic)] px-3 py-1.5 text-[13px] text-[var(--content-value)]">
      <span style={{ color: SIGNAL_COLOR[signal] }}>{entry.state ?? "—"}</span>
      <span className="text-[var(--content-accent)]">{entry.endpoint}</span>
      {entry.durationMs === undefined ? null : (
        <span
          className="text-[var(--content-dim)]"
          title={approximateDurationTitle}
        >
          {approximateDuration ? "≈" : ""}
          {formatDuration(entry.durationMs)}
        </span>
      )}
      {attemptCount === undefined ? null : <span className="text-[var(--content-dim)]">{attemptCount} att</span>}
      {tokens ?
        <span className="text-[var(--content-dim)]">{formatUsageTokens(tokens)} tok</span>
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
