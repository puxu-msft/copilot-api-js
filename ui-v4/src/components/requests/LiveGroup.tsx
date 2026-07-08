import { memo } from "react"

import type { LiveGroupData } from "@/lib/live-summary"
import type {
  //
  LiveEntry,
} from "@/stores/live-store"

import {
  //
  formatDuration,
  statusSignal,
} from "@/lib/format"
import {
  //
  SIGNAL_COLOR,
} from "@/lib/request-columns"

const ROW_CLASS = "mono flex w-full items-center gap-2 border-b border-[#1c2a1e] px-2 py-1 text-left text-[12px]"

function modelLabel(row: LiveEntry): string {
  if (row.resolvedModel && row.clientModel && row.resolvedModel !== row.clientModel) return `${row.clientModel}→${row.resolvedModel}`
  return row.resolvedModel ?? row.model ?? row.clientModel ?? "—"
}

/** 单请求富明细行 —— memo 以避免每秒滴答重渲全部行(仅 elapsed 文本随 nowMs 变)。 */
export const LiveDetailRow = memo(function LiveDetailRow({ row, nowMs, onClick }: { row: LiveEntry; nowMs: number; onClick: () => void }) {
  const elapsed = formatDuration(Math.max(0, nowMs - row.startTime))
  const attempt = row.attemptCount && row.attemptCount > 1 ? `×${row.attemptCount}` : ""
  const queue = row.queueWaitMs && row.queueWaitMs > 100 ? `q:${formatDuration(row.queueWaitMs)}` : ""
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${ROW_CLASS} text-[#9db]`}
    >
      <span
        className="w-[84px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap"
        style={{ color: SIGNAL_COLOR[statusSignal(row.state)] }}
      >
        ◐ {row.state}
      </span>
      <span className="w-[52px] shrink-0 text-right text-[#8a8]">{elapsed}</span>
      <span
        className="w-[78px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[#788]"
        title={row.endpoint}
      >
        {row.endpoint}
      </span>
      <span
        className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[#cdb]"
        title={modelLabel(row)}
      >
        {modelLabel(row)}
      </span>
      {attempt ?
        <span className="shrink-0 text-[#a87]">
          {attempt} {row.currentStrategy ?? ""}
        </span>
      : null}
      {queue ?
        <span className="shrink-0 text-[#887]">{queue}</span>
      : null}
      {row.stream ?
        <span
          className="shrink-0 text-[#7a9]"
          title="streaming"
        >
          ⚡
        </span>
      : null}
      {row.requestBodySize ?
        <span
          className="shrink-0 text-[#778]"
          title="request bytes"
        >
          {Math.round(row.requestBodySize / 1024)}k
        </span>
      : null}
      {row.transport ?
        <span
          className="shrink-0 text-[#688]"
          title="transport"
        >
          {row.transport}
        </span>
      : null}
      {row.retry?.willRetry ?
        <span
          className="shrink-0 text-[var(--color-warn)]"
          title="retrying"
        >
          ↻ next:{row.retry.nextStrategy ?? "?"} 等{formatDuration(row.retry.waitMs)}
        </span>
      : null}
    </button>
  )
})

/** 一组(同 resolved model)—— 组头(showHeader 时)+ oldest-first 明细行。 */
export function LiveGroup({
  group,
  nowMs,
  showHeader,
  onSelect,
}: {
  group: LiveGroupData
  nowMs: number
  showHeader: boolean
  onSelect: (id: string) => void
}) {
  return (
    <div>
      {showHeader ?
        <div className="mono flex items-center gap-2 bg-[#101a12] px-2 py-0.5 text-[11px] uppercase tracking-wider text-[#6a9a7a]">
          <span className="text-[#cdb]">{group.model}</span>
          <span>×{group.count}</span>
          {group.streaming > 0 ?
            <span className="text-[#7a9]">⚡{group.streaming}</span>
          : null}
          <span className="ml-auto text-[#688]">oldest {formatDuration(group.oldestElapsedMs)}</span>
        </div>
      : null}
      {group.rows.map((r) => (
        <LiveDetailRow
          key={r.id}
          row={r}
          nowMs={nowMs}
          onClick={() => onSelect(r.id)}
        />
      ))}
    </div>
  )
}
