// Requests 列表的 TanStack 列模型 —— 把 RequestRow.tsx 的 HistoryRow 富行(逐个
// `<span>`)转成结构化 ColumnDef，信号色/tooltip/anomaly 逻辑平移进 `cell`。
//
// 三条单一真值源在此定义、供别处 import：
//   · COLUMN_WIDTHS  —— 列宽(Live 泳道 Task 3.4 import 对齐，红线 M4)。
//   · DEFAULT_COLUMN_VISIBILITY / mergeColumnVisibility —— 列可见性 + schema 对账(镜像 model-columns.ts)。
//   · REQUEST_COLUMNS —— 渲染列定义(HistoryList Task 3.2 喂给 useReactTable)。
import type {
  //
  ColumnDef,
  RowData,
  VisibilityState,
} from "@tanstack/react-table"

import {
  //
  createElement,
  type ReactNode,
} from "react"

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
  formatElapsed,
  formatTime,
  statusSignal,
  type Signal,
} from "@/lib/format"

// 列宽经 `meta.width` 走 TanStack 的 ColumnMeta(SSOT = COLUMN_WIDTHS)；augment 声明它。
declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** 列宽 Tailwind 类(取自 COLUMN_WIDTHS)，HistoryList 套在单元格外壳上。 */
    width?: string
  }
}

/**
 * 工业信号色 → CSS 变量。本文件是该表 + 下面 cell 文本拼装 helper 的单一真值源;
 * RequestRow.tsx 的 HistoryRow(仍服务 AgentLane 泳道)/LiveRow 从此处 import 复用
 * (Task 3.2 去重:原先两文件各持一份副本,现收敛到这里)。
 */
export const SIGNAL_COLOR: Record<Signal, string> = {
  ok: "var(--color-ok)",
  fail: "var(--color-fail)",
  warn: "var(--color-warn)",
  live: "var(--color-ok)",
  muted: "var(--color-muted)",
}

// ── cell 文本拼装(SSOT;RequestRow.tsx 的 HistoryRow/LiveRow 复用本组 helper) ──

/**
 * Tokens 单元格文本:`↑<in>(+<cacheRead>c) ↓<out>`，把 cache-read 命中量并入
 * 上行(input)方向显示，无 cache read(`tokenCacheRead`→"-")时省略 `+Nc` 后缀。
 */
export function tokensCellText(input: string, output: string, cacheRead: string): string {
  const cached = cacheRead === "-" ? "" : `+${cacheRead}c`
  return `↑${input}${cached} ↓${output}`
}

/**
 * Bytes 单元格文本:`↑<req> ↓<resp>` 数据大小；仅一侧有值只渲染该侧(不留悬空箭头)，
 * 二者皆缺(老行无 request/response_bytes 列)→ ""。
 */
export function bytesCellText(requestBytes: number | undefined, responseBytes: number | undefined): string {
  const up = requestBytes === undefined ? "" : `↑${formatBytes(requestBytes)}`
  const down = responseBytes === undefined ? "" : `↓${formatBytes(responseBytes)}`
  return [up, down].filter(Boolean).join(" ")
}

/** Tokens 单元格的 hover title:有 usage 用原始计数，否则回退到紧凑单元格文本。 */
export function tokensCellTitle(entry: EntrySummary, fallback: string): string {
  if (!entry.usage) return fallback
  const parts = [`input ${entry.usage.input_tokens}`]
  if (entry.usage.cache_read_input_tokens) parts.push(`cached ${entry.usage.cache_read_input_tokens}`)
  parts.push(`output ${entry.usage.output_tokens}`)
  return parts.join(" · ")
}

/** Bytes 单元格的 hover title(`request 1.5KB · response 2.4MB`)。 */
export function bytesCellTitle(requestBytes: number | undefined, responseBytes: number | undefined): string {
  const up = requestBytes === undefined ? "" : `request ${formatBytes(requestBytes)}`
  const down = responseBytes === undefined ? "" : `response ${formatBytes(responseBytes)}`
  return [up, down].filter(Boolean).join(" · ")
}

/** 小工具:一个带 className/style/title 的 span cell(width 由 COLUMN_WIDTHS 在外层套壳，故不含宽度类)。 */
function span(className: string, text: string, opts?: { color?: string; title?: string }): ReactNode {
  return createElement(
    "span",
    {
      className,
      style: opts?.color ? { color: opts.color } : undefined,
      title: opts?.title,
    },
    text,
  )
}

const ELLIPSIS = "overflow-hidden text-ellipsis whitespace-nowrap"

/**
 * 列宽单一真值源(Tailwind 宽度类)。RequestRow.tsx 现有像素宽逐字搬来；Live 泳道
 * (Task 3.4) import 本表对齐，故改宽度只改这一处。preview 列吃满剩余空间。
 */
export const COLUMN_WIDTHS: Record<string, string> = {
  status: "w-[92px]",
  time: "w-[68px]",
  dur: "w-[64px]",
  model: "w-[180px]",
  multiplier: "w-[34px]",
  endpoint: "w-[90px]",
  bytes: "w-[118px]",
  tokens: "w-[130px]",
  attempts: "w-[40px]",
  preview: "min-w-0 flex-1",
}

/**
 * REQUEST_COLUMNS —— 状态·时间·+耗时·模型·(Nx)·端点·字节·token·×N·预览/失败摘要
 * (spec §4.2)。每列 `accessorFn` 给出可排序/筛选的域值(复用 activity-row)，`cell`
 * 渲染富内容(信号色/tooltip/anomaly)。`meta.width` 引 COLUMN_WIDTHS(SSOT)。
 */
export const REQUEST_COLUMNS: Array<ColumnDef<EntrySummary>> = [
  {
    id: "status",
    header: "Status",
    accessorFn: (e) => requestState(e),
    cell: ({ row }) => {
      const state = requestState(row.original)
      return span(ELLIPSIS, `● ${state}`, { color: SIGNAL_COLOR[statusSignal(state)] })
    },
    meta: { width: COLUMN_WIDTHS.status },
  },
  {
    id: "time",
    header: "Time",
    accessorFn: (e) => e.startedAt,
    cell: ({ row }) => span("text-[#777]", formatTime(row.original.startedAt), { title: new Date(row.original.startedAt).toISOString() }),
    meta: { width: COLUMN_WIDTHS.time },
  },
  {
    id: "dur",
    header: "Dur",
    accessorFn: (e) => e.durationMs,
    cell: ({ row }) => {
      const e = row.original
      const anomaly = rowAnomaly(e)
      const className = anomaly.slow ? "row-anomaly text-[var(--color-warn)]" : "text-[#888]"
      return span(className, e.durationMs === undefined ? "" : formatElapsed(e.durationMs), {
        title: anomaly.slow ? "slow request (>60s)" : undefined,
      })
    },
    meta: { width: COLUMN_WIDTHS.dur },
  },
  {
    id: "model",
    header: "Model",
    accessorFn: (e) => modelName(e),
    cell: ({ row }) => span(`${ELLIPSIS} text-[#cdb]`, modelName(row.original), { title: modelName(row.original) }),
    meta: { width: COLUMN_WIDTHS.model },
  },
  {
    id: "multiplier",
    header: "×",
    accessorFn: (e) => e.multiplier ?? 1,
    cell: ({ row }) => {
      const m = row.original.multiplier
      const show = m !== undefined && m !== 1
      return span("text-[var(--color-muted)]", show ? `(${m}x)` : "")
    },
    meta: { width: COLUMN_WIDTHS.multiplier },
  },
  {
    id: "endpoint",
    header: "Endpoint",
    accessorFn: (e) => endpointLabel(e),
    cell: ({ row }) => span(`${ELLIPSIS} text-[#777]`, endpointLabel(row.original), { title: endpointLabel(row.original) }),
    meta: { width: COLUMN_WIDTHS.endpoint },
  },
  {
    id: "bytes",
    header: "Bytes",
    accessorFn: (e) => (e.requestBytes ?? 0) + (e.responseBytes ?? 0),
    cell: ({ row }) => {
      const e = row.original
      return span(`${ELLIPSIS} text-right text-[var(--color-muted)]`, bytesCellText(e.requestBytes, e.responseBytes), {
        title: bytesCellTitle(e.requestBytes, e.responseBytes),
      })
    },
    meta: { width: COLUMN_WIDTHS.bytes },
  },
  {
    id: "tokens",
    header: "Tokens",
    accessorFn: (e) => (e.usage?.input_tokens ?? 0) + (e.usage?.output_tokens ?? 0),
    cell: ({ row }) => {
      const e = row.original
      const anomaly = rowAnomaly(e)
      const text = tokensCellText(tokenIn(e), tokenOut(e), tokenCacheRead(e))
      const className = anomaly.cacheMiss ? "row-anomaly text-[var(--color-warn)]" : "text-[#9a9]"
      return span(`${ELLIPSIS} text-right ${className}`, text, {
        title: anomaly.cacheMiss ? "cache miss: large input with no cache read" : tokensCellTitle(e, text),
      })
    },
    meta: { width: COLUMN_WIDTHS.tokens },
  },
  {
    id: "attempts",
    header: "Att",
    accessorFn: (e) => e.attemptCount ?? 1,
    cell: ({ row }) => {
      const n = row.original.attemptCount
      return span("text-right text-[#a87]", n && n > 1 ? `×${n}` : "")
    },
    meta: { width: COLUMN_WIDTHS.attempts },
  },
  {
    id: "preview",
    header: "Preview",
    accessorFn: (e) => (requestState(e) === "completed" ? truncPreview(e) : failureSummary(e)),
    cell: ({ row }) => {
      const e = row.original
      const completed = requestState(e) === "completed"
      const title = completed ? e.previewText || truncPreview(e) : failureSummary(e)
      const className = completed ? `${ELLIPSIS} text-[#8a8a7a]` : `${ELLIPSIS} text-[var(--color-fail)]`
      return span(className, completed ? truncPreview(e) : failureSummary(e), { title })
    },
    meta: { width: COLUMN_WIDTHS.preview },
  },
]

/** 列 id 顺序(单一来源，供可见性默认/对账/菜单迭代)。 */
export const REQUEST_COLUMN_IDS: ReadonlyArray<string> = REQUEST_COLUMNS.map((c) => c.id as string)

/** localStorage 键 —— Requests 列表的列可见性持久化。 */
export const COLUMN_STORAGE_KEY = "ui-v4:requests:columns"

/** 全列默认可见(true)。 */
export const DEFAULT_COLUMN_VISIBILITY: VisibilityState = Object.fromEntries(REQUEST_COLUMN_IDS.map((id) => [id, true]))

/**
 * 把持久化的可见性 blob 合并到默认之上:未知/缺失列取默认可见(retain-on-absence
 * —— 早于新列的旧 blob 仍可用)，未知的持久化键被丢弃。逐字镜像 model-columns.ts。
 */
export function mergeColumnVisibility(persisted: Partial<VisibilityState> | null | undefined): VisibilityState {
  const merged = { ...DEFAULT_COLUMN_VISIBILITY }
  if (persisted && typeof persisted === "object") {
    for (const id of REQUEST_COLUMN_IDS) {
      const v = persisted[id]
      if (typeof v === "boolean") merged[id] = v
    }
  }
  return merged
}
