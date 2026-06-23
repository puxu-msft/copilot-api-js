import type { HistoryEntry } from "@/types"

function Row({ label, value }: { label: string; value?: string | number }) {
  if (value === undefined) return null
  return (
    <div className="flex gap-2">
      <span className="w-[80px] text-[var(--color-muted)]">{label}</span>
      <span>{value}</span>
    </div>
  )
}

export function MetaSegment({ entry }: { entry: HistoryEntry }) {
  const usage = entry.outboundResponse?.usage
  return (
    <div className="mono flex flex-col gap-2 text-[13px] text-[#aaa]">
      <Row
        label="strategy"
        value={entry.currentStrategy}
      />
      <Row
        label="transport"
        value={entry.transport}
      />
      <Row
        label="attempts"
        value={entry.attemptCount}
      />
      <Row
        label="queue wait"
        value={entry.queueWaitMs === undefined ? undefined : `${entry.queueWaitMs}ms`}
      />
      <Row
        label="stop reason"
        value={entry.outboundResponse?.stop_reason}
      />
      {usage ?
        <Row
          label="tokens"
          value={`↑${usage.input_tokens} ↓${usage.output_tokens}`}
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
