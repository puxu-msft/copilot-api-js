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
  formatElapsed,
  formatTime,
  statusSignal,
} from "@/lib/format"
// 信号色 + cell 文本拼装 helper 在 request-columns.ts(TanStack 列模型同源)；本文件的
// HistoryRow(AgentLane 泳道复用)从此处 import,不再各自持副本(Task 3.2 去重)。列宽 =
// ColumnDef.size(Requests 列表用);Live 泳道 RequestRow 自持硬编码宽,不复用本表。
import {
  //
  bytesCellText,
  bytesCellTitle,
  SIGNAL_COLOR,
  tokensCellText,
  tokensCellTitle,
} from "@/lib/request-columns"

interface RequestRowProps {
  /** History 行:完整 EntrySummary,渲染富统计行。 */
  entry?: EntrySummary
  selected?: boolean
  onClick?: () => void
}

const ROW_CLASS = "mono flex w-full items-center gap-2 border-b border-[var(--surface-border-row)] px-2 py-1 text-left text-[13px]"

function selectionClass(selected: boolean | undefined): string {
  return selected ? "border-l-2 border-l-[var(--content-accent)] bg-[var(--surface-active)] text-[var(--content-selected)]" : "text-[var(--content-secondary)]"
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
  const timingSource = entry.timing?.operation?.source
  const approximateDuration = timingSource === "storage-commit-upper-bound" || timingSource === "terminal-log-rounded"
  let durationTitle: string | undefined
  if (timingSource === "storage-commit-upper-bound") durationTitle = "历史时长上界（以持久化提交时间估算）"
  else if (timingSource === "terminal-log-rounded") durationTitle = "终端舍入日志恢复时长"
  else if (anomaly.slow) durationTitle = "slow request (>60s)"
  const durationText = entry.durationMs === undefined ? "" : `${approximateDuration ? "≈" : ""}${formatElapsed(entry.durationMs)}`

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
        className="w-[68px] shrink-0 text-[var(--content-faint)]"
        title={new Date(entry.startedAt).toISOString()}
      >
        {formatTime(entry.startedAt)}
      </span>
      <span
        className={`w-[64px] shrink-0 ${anomaly.slow ? "row-anomaly text-[var(--signal-warn)]" : "text-[var(--content-dim)]"}`}
        title={durationTitle}
      >
        {durationText}
      </span>
      <span
        className="w-[180px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--content-value)]"
        title={modelName(entry)}
      >
        {modelName(entry)}
      </span>
      {showMultiplier ?
        <span className="w-[34px] shrink-0 text-[var(--content-muted)]">({entry.multiplier}x)</span>
      : null}
      <span
        className="w-[90px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--content-faint)]"
        title={endpointLabel(entry)}
      >
        {endpointLabel(entry)}
      </span>
      <span
        className="w-[118px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-right text-[var(--content-muted)]"
        title={bytesCellTitle(entry.requestBytes, entry.responseBytes)}
      >
        {bytesText}
      </span>
      <span
        className={`w-[130px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-right ${anomaly.cacheMiss ? "row-anomaly text-[var(--signal-warn)]" : "text-[var(--content-muted-cool)]"}`}
        title={anomaly.cacheMiss ? "cache miss: large input with no cache read" : tokensCellTitle(entry, tokensText)}
      >
        {tokensText}
      </span>
      <span className="w-[40px] shrink-0 text-right text-[var(--content-warm-faint)]">
        {entry.attemptCount && entry.attemptCount > 1 ? `×${entry.attemptCount}` : ""}
      </span>
      {completed ?
        <span
          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--content-preview)]"
          title={previewTitle}
        >
          {truncPreview(entry)}
        </span>
      : <span
          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--signal-fail)]"
          title={previewTitle}
        >
          {failureSummary(entry)}
        </span>
      }
      {entry.responsePreviewText ?
        <span
          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--content-preview-response)]"
          title={entry.responsePreviewText}
        >
          {truncResponsePreview(entry)}
        </span>
      : null}
    </button>
  )
}

/** 单行请求摘要 —— History 富行(entry)(spec §4.2 列表行)。 */
export function RequestRow({ entry, selected, onClick }: RequestRowProps) {
  if (entry)
    return (
      <HistoryRow
        entry={entry}
        selected={selected}
        onClick={onClick}
      />
    )
  return null
}
