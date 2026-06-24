import type { EntrySummary } from "@/types"

import {
  //
  endpointLabel,
  failureSummary,
  modelName,
  requestState,
  rowAnomaly,
  tokenCacheRead,
  tokenIn,
  tokenOut,
  truncPreview,
} from "@/lib/activity-row"
import {
  //
  formatDuration,
  formatTime,
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

interface LiveRowInfo {
  state: string
  model?: string
  durationMs?: number
}

interface RequestRowProps {
  /** History 行:完整 EntrySummary,渲染富统计行。 */
  entry?: EntrySummary
  /** Live 行:在飞紧凑子集(无 usage / preview)。 */
  live?: LiveRowInfo
  selected?: boolean
  onClick?: () => void
}

const ROW_CLASS = "mono flex w-full items-center gap-2 border-b border-[#222] px-2 py-1 text-left text-[13px]"

function selectionClass(selected: boolean | undefined): string {
  return selected ? "border-l-2 border-l-[var(--color-primary)] bg-[#3a2f1a] text-[#f0d8a8]" : "text-[#aaa]"
}

/** Live 紧凑行 —— 信号色状态 + 模型 + 时长(在飞无 token / preview)。 */
function LiveRow({ live, selected, onClick }: { live: LiveRowInfo; selected?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${ROW_CLASS} ${selectionClass(selected)}`}
    >
      <span style={{ color: SIGNAL_COLOR[statusSignal(live.state)] }}>◐ {live.state}</span>
      <span className="text-[#cdb]">{live.model ?? "—"}</span>
      <span className="ml-auto text-[#888]">{live.durationMs === undefined ? "" : formatDuration(live.durationMs)}</span>
    </button>
  )
}

/** cacheRead 单元格文本:命中 miss 异常显 "(miss)",有值显 "(N)",无则空。 */
function cacheCellText(cacheRead: string, cacheMiss: boolean): string {
  if (cacheMiss) return "(miss)"
  if (cacheRead === "-") return ""
  return `(${cacheRead})`
}

/** History 富行 —— 状态·时间·模型·端点·↑in↓out·cacheRead·×N·时长·预览/失败摘要(spec §4.2)。 */
function HistoryRow({ entry, selected, onClick }: { entry: EntrySummary; selected?: boolean; onClick?: () => void }) {
  const state = requestState(entry)
  const completed = state === "completed"
  const cacheRead = tokenCacheRead(entry)
  const anomaly = rowAnomaly(entry)

  return (
    <button
      type="button"
      onClick={onClick}
      className={`${ROW_CLASS} ${selectionClass(selected)}`}
    >
      <span
        className="w-[92px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap"
        style={{ color: SIGNAL_COLOR[statusSignal(state)] }}
      >
        ● {state}
      </span>
      <span className="w-[68px] shrink-0 text-[#777]">{formatTime(entry.startedAt)}</span>
      <span className="w-[180px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[#cdb]">{modelName(entry)}</span>
      <span className="w-[90px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[#777]">{endpointLabel(entry)}</span>
      <span className="w-[52px] shrink-0 text-right text-[#9a9]">↑{tokenIn(entry)}</span>
      <span className="w-[52px] shrink-0 text-right text-[#9a9]">↓{tokenOut(entry)}</span>
      <span
        className={`w-[52px] shrink-0 text-right ${anomaly.cacheMiss ? "row-anomaly text-[var(--color-warn)]" : "text-[#7fb3b3]"}`}
        title={anomaly.cacheMiss ? "cache miss: large input with no cache read" : undefined}
      >
        {cacheCellText(cacheRead, anomaly.cacheMiss)}
      </span>
      <span className="w-[40px] shrink-0 text-right text-[#a87]">{entry.attemptCount && entry.attemptCount > 1 ? `×${entry.attemptCount}` : ""}</span>
      <span
        className={`w-[52px] shrink-0 text-right ${anomaly.slow ? "row-anomaly text-[var(--color-warn)]" : "text-[#888]"}`}
        title={anomaly.slow ? "slow request (>60s)" : undefined}
      >
        {entry.durationMs === undefined ? "" : formatDuration(entry.durationMs)}
      </span>
      {completed ?
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[#8a8a7a]">{truncPreview(entry)}</span>
      : <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--color-fail)]">{failureSummary(entry)}</span>}
    </button>
  )
}

/** 单行请求摘要 —— History 富行(entry) 或 Live 紧凑行(live)(spec §4.2 列表行)。 */
export function RequestRow({ entry, live, selected, onClick }: RequestRowProps) {
  if (entry)
    return (
      <HistoryRow
        entry={entry}
        selected={selected}
        onClick={onClick}
      />
    )
  if (live)
    return (
      <LiveRow
        live={live}
        selected={selected}
        onClick={onClick}
      />
    )
  return null
}
