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
  formatBytes,
  formatDuration,
  formatElapsed,
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
      <span
        className="text-[#cdb]"
        title={live.model ?? undefined}
      >
        {live.model ?? "—"}
      </span>
      <span className="ml-auto text-[#888]">{live.durationMs === undefined ? "" : formatDuration(live.durationMs)}</span>
    </button>
  )
}

/**
 * Tokens 单元格文本:`↑<in>(+<cacheRead>c) ↓<out>`,把 cache-read 命中量并入
 * 上行(input)方向显示,无 cache read(`tokenCacheRead`→"-")时省略 `+Nc` 后缀。
 * 例:`↑1.5K+340c ↓250` / `↑1.5K ↓250` / `↑- ↓-`(无 usage)。
 */
function tokensCellText(input: string, output: string, cacheRead: string): string {
  const cached = cacheRead === "-" ? "" : `+${cacheRead}c`
  return `↑${input}${cached} ↓${output}`
}

/**
 * Bytes 单元格文本:`↑<req> ↓<resp>` 数据大小(区别于 token 计数的 ↑in↓out)。
 * 按侧分别拼接:仅一侧有值(如失败行有请求字节、无响应字节)只渲染该侧,
 * 不留悬空箭头;二者皆缺(老行无 request/response_bytes 列)→ ""。
 */
function bytesCellText(requestBytes: number | undefined, responseBytes: number | undefined): string {
  const up = requestBytes === undefined ? "" : `↑${formatBytes(requestBytes)}`
  const down = responseBytes === undefined ? "" : `↓${formatBytes(responseBytes)}`
  return [up, down].filter(Boolean).join(" ")
}

/**
 * Human-readable hover title for the tokens cell. Uses raw `entry.usage` counts
 * when present (`input 1500 · cached 340 · output 250`), else falls back to the
 * already-formatted compact cell text so a truncated string still shows in full.
 */
function tokensCellTitle(entry: EntrySummary, fallback: string): string {
  if (!entry.usage) return fallback
  const parts = [`input ${entry.usage.input_tokens}`]
  if (entry.usage.cache_read_input_tokens) parts.push(`cached ${entry.usage.cache_read_input_tokens}`)
  parts.push(`output ${entry.usage.output_tokens}`)
  return parts.join(" · ")
}

/** Human-readable hover title for the bytes cell (`request 1.5KB · response 2.4MB`). */
function bytesCellTitle(requestBytes: number | undefined, responseBytes: number | undefined): string {
  const up = requestBytes === undefined ? "" : `request ${formatBytes(requestBytes)}`
  const down = responseBytes === undefined ? "" : `response ${formatBytes(responseBytes)}`
  return [up, down].filter(Boolean).join(" · ")
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
