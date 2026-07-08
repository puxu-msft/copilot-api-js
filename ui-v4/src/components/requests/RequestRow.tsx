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
  truncResponsePreview,
} from "@/lib/activity-row"
import {
  //
  formatDuration,
  formatElapsed,
  formatTime,
  statusSignal,
} from "@/lib/format"
// 信号色 + cell 文本拼装 helper + 列宽 SSOT 在 request-columns.ts(TanStack 列模型同源)；
// 本文件的 HistoryRow(AgentLane 泳道复用)/LiveRow 从此处 import,不再各自持副本(Task 3.2 去重)。
// LiveRow 的共有列宽(status/model/dur)取 COLUMN_WIDTHS(Task 3.4),与 History 表列对齐、改宽度只改一处。
import {
  //
  bytesCellText,
  bytesCellTitle,
  COLUMN_WIDTHS,
  SIGNAL_COLOR,
  tokensCellText,
  tokensCellTitle,
} from "@/lib/request-columns"

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
      <span
        className={`${COLUMN_WIDTHS.status} shrink-0 overflow-hidden text-ellipsis whitespace-nowrap`}
        style={{ color: SIGNAL_COLOR[statusSignal(live.state)] }}
      >
        ◐ {live.state}
      </span>
      <span
        className={`${COLUMN_WIDTHS.model} shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[#cdb]`}
        title={live.model ?? undefined}
      >
        {live.model ?? "—"}
      </span>
      <span className={`${COLUMN_WIDTHS.dur} ml-auto shrink-0 text-right text-[#888]`}>
        {live.durationMs === undefined ? "" : formatDuration(live.durationMs)}
      </span>
    </button>
  )
}

/** History 富行 —— 状态·时间·+耗时·模型·(Nx)·端点·字节·token·×N·预览/失败摘要(spec §4.2)。 */
function HistoryRow({ entry, selected, onClick }: { entry: EntrySummary; selected?: boolean; onClick?: () => void }) {
  const state = requestState(entry)
  const completed = state === "completed"
  const cacheRead = tokenCacheRead(entry)
  const anomaly = rowAnomaly(entry)
  const showMultiplier = entry.multiplier !== undefined && entry.multiplier !== 1
  const tokensText = tokensCellText(tokenIn(entry), tokenOut(entry), cacheRead)
  const bytesText = bytesCellText(entry.requestBytes, entry.responseBytes)
  const previewTitle = completed ? entry.previewText || truncPreview(entry) : failureSummary(entry)

  return (
    <button
      type="button"
      data-entry-id={entry.id}
      onClick={onClick}
      className={`${ROW_CLASS} ${selectionClass(selected)}`}
    >
      <span
        className="w-[92px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap"
        style={{ color: SIGNAL_COLOR[statusSignal(state)] }}
      >
        ● {state}
      </span>
      <span
        className="w-[68px] shrink-0 text-[#777]"
        title={new Date(entry.startedAt).toISOString()}
      >
        {formatTime(entry.startedAt)}
      </span>
      <span
        className={`w-[64px] shrink-0 ${anomaly.slow ? "row-anomaly text-[var(--color-warn)]" : "text-[#888]"}`}
        title={anomaly.slow ? "slow request (>60s)" : undefined}
      >
        {entry.durationMs === undefined ? "" : formatElapsed(entry.durationMs)}
      </span>
      <span
        className="w-[180px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[#cdb]"
        title={modelName(entry)}
      >
        {modelName(entry)}
      </span>
      {showMultiplier ?
        <span className="w-[34px] shrink-0 text-[var(--color-muted)]">({entry.multiplier}x)</span>
      : null}
      <span
        className="w-[90px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[#777]"
        title={endpointLabel(entry)}
      >
        {endpointLabel(entry)}
      </span>
      <span
        className="w-[118px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-right text-[var(--color-muted)]"
        title={bytesCellTitle(entry.requestBytes, entry.responseBytes)}
      >
        {bytesText}
      </span>
      <span
        className={`w-[130px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-right ${anomaly.cacheMiss ? "row-anomaly text-[var(--color-warn)]" : "text-[#9a9]"}`}
        title={anomaly.cacheMiss ? "cache miss: large input with no cache read" : tokensCellTitle(entry, tokensText)}
      >
        {tokensText}
      </span>
      <span className="w-[40px] shrink-0 text-right text-[#a87]">{entry.attemptCount && entry.attemptCount > 1 ? `×${entry.attemptCount}` : ""}</span>
      {completed ?
        <span
          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[#8a8a7a]"
          title={previewTitle}
        >
          {truncPreview(entry)}
        </span>
      : <span
          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--color-fail)]"
          title={previewTitle}
        >
          {failureSummary(entry)}
        </span>
      }
      {entry.responsePreviewText ?
        <span
          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[#8a9a8a]"
          title={entry.responsePreviewText}
        >
          {truncResponsePreview(entry)}
        </span>
      : null}
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
