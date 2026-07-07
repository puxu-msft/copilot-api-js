import {
  //
  resolveAttemptCount,
  resolveCurrentStrategy,
  resolveResponseUsage,
  resolveStopReason,
} from "~backend/lib/history/entry-view"

import type { HistoryEntry } from "@/types"

import { formatUsageTokens } from "@/lib/format"

function Row({ label, value }: { label: string; value?: string | number }) {
  if (value === undefined) return null
  return (
    <div className="flex gap-2">
      <span className="w-[100px] text-[var(--color-muted)]">{label}</span>
      <span>{value}</span>
    </div>
  )
}

export function MetaSegment({ entry }: { entry: HistoryEntry }) {
  // New legs (`_index.derived` / final attempt `upstreamResponse`); legacy top-level legs removed in P4c.
  const usage = resolveResponseUsage(entry)
  return (
    <div className="mono flex flex-col gap-2 text-[13px] text-[#aaa]">
      <Row
        label="strategy"
        value={resolveCurrentStrategy(entry)}
      />
      <Row
        label="transport"
        value={entry.transport}
      />
      <Row
        label="attempts"
        value={resolveAttemptCount(entry)}
      />
      <Row
        label="queue wait"
        value={entry.queueWaitMs === undefined ? undefined : `${entry.queueWaitMs}ms`}
      />
      <Row
        label="stop reason"
        value={resolveStopReason(entry)}
      />
      {usage ?
        <Row
          label="tokens"
          value={formatUsageTokens(usage)}
        />
      : null}
      {entry.warningMessages && entry.warningMessages.length > 0 ?
        <div>
          <div className="text-[11px] uppercase tracking-wider text-[var(--color-warn)]">warnings</div>
          {entry.warningMessages.map((w, i) => (
            <div
              key={i}
              className="text-[var(--color-warn)]"
            >
              {w.code}: {w.message}
            </div>
          ))}
        </div>
      : null}
    </div>
  )
}
