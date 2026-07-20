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
      <span className="w-[100px] text-[var(--content-muted)]">{label}</span>
      <span>{value}</span>
    </div>
  )
}

/** 首包/时序派生值（spec 2026-07-14 §6.4）：上游 4 刻是绝对 epoch，client 3 刻是相对 started_at 的 offset。 */
function deriveTiming(entry: HistoryEntry): {
  upstreamTtftMs?: number
  clientFirstRealMs?: number
  keepaliveGapMs?: number
  bufferHoldMs?: number
  buffered: boolean
} {
  const committed = entry.attempts?.at(-1)
  const upstreamTtftMs = committed?.upstreamFirstTokenAt === undefined ? undefined : committed.upstreamFirstTokenAt - entry.startedAt
  const client = entry.timing?.client
  const firstRealMs = client?.firstRealMs
  const streamOpenMs = client?.streamOpenMs
  const bufferHoldStartMs = client?.bufferHoldStartMs
  const keepaliveGapMs = firstRealMs === undefined || streamOpenMs === undefined ? undefined : firstRealMs - streamOpenMs
  const bufferHoldMs = firstRealMs === undefined || bufferHoldStartMs === undefined ? undefined : firstRealMs - bufferHoldStartMs
  return { upstreamTtftMs, clientFirstRealMs: firstRealMs, keepaliveGapMs, bufferHoldMs, buffered: bufferHoldStartMs !== undefined }
}

const fmtMs = (ms?: number): string | undefined => (ms === undefined ? undefined : `${ms}ms`)

/** buffer hold 显示：缓冲态显时长；透传态（有客户端首包但无扣留）显 "passthrough"；无数据不显。 */
function bufferHoldDisplay(t: ReturnType<typeof deriveTiming>): string | undefined {
  if (t.bufferHoldMs !== undefined) return fmtMs(t.bufferHoldMs)
  if (!t.buffered && t.clientFirstRealMs !== undefined) return "passthrough"
  return undefined
}

export function MetaSegment({ entry }: { entry: HistoryEntry }) {
  // New legs (`_index.derived` / final attempt `upstreamResponse`); legacy top-level legs removed in P4c.
  const usage = resolveResponseUsage(entry)
  const t = deriveTiming(entry)
  return (
    <div className="mono flex flex-col gap-2 text-[13px] text-[var(--content-secondary)]">
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
      {/* 首包/时序（spec 2026-07-14 §6.4）：上游 TTFT / 客户端可见首包 / keepalive 空窗 / 缓冲扣留 */}
      <Row
        label="upstream TTFT"
        value={fmtMs(t.upstreamTtftMs)}
      />
      <Row
        label="client 1st pkt"
        value={fmtMs(t.clientFirstRealMs)}
      />
      <Row
        label="keepalive gap"
        value={fmtMs(t.keepaliveGapMs)}
      />
      <Row
        label="buffer hold"
        value={bufferHoldDisplay(t)}
      />
      {usage ?
        <Row
          label="tokens"
          value={formatUsageTokens(usage)}
        />
      : null}
      {entry.warningMessages && entry.warningMessages.length > 0 ?
        <div>
          <div className="text-[11px] uppercase tracking-wider text-[var(--signal-warn)]">warnings</div>
          {entry.warningMessages.map((w, i) => (
            <div
              key={i}
              className="text-[var(--signal-warn)]"
            >
              {w.code}: {w.message}
            </div>
          ))}
        </div>
      : null}
    </div>
  )
}
