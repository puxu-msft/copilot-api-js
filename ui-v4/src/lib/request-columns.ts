// Requests 列表的 TanStack 列模型 —— 把 RequestRow.tsx 的 HistoryRow 富行(逐个
// `<span>`)转成结构化 ColumnDef，信号色/tooltip/anomaly 逻辑平移进 `cell`。
//
// 单一真值源在此定义、供别处 import：
//   · 列宽 = ColumnDef.size —— 固定列自带 size(px)，弹性列(preview/response)/session
//     用 `enableResizing:false` + 不设 size；Live 泳道 RequestRow 自持硬编码宽(不复用本表)。
//   · DEFAULT_COLUMN_VISIBILITY / DEFAULT_COLUMN_ORDER / DEFAULT_COLUMN_SIZING + 三个 merge
//     纯函数 —— 版本化列状态默认值 + 持久化对账(useColumnState 消费)。
//   · REQUEST_COLUMNS —— 渲染列定义(HistoryList 喂给 useReactTable)。
import type {
  //
  ColumnDef,
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
  cacheHitCell,
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
  formatBytes,
  formatElapsed,
  formatTime,
  statusSignal,
  type Signal,
} from "@/lib/format"

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

/** 小工具:一个带 className/style/title 的 span cell(列宽由 ColumnDef.size 在 th/td 上套 inline width，故不含宽度类)。 */
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
 * REQUEST_COLUMNS —— 状态·时间·+耗时·模型·cache·(Nx)·端点·字节·token·×N·预览/失败摘要
 * (spec §4.2)。每列 `accessorFn` 给出可排序/筛选的域值(复用 activity-row)，`cell`
 * 渲染富内容(信号色/tooltip/anomaly)。固定列自带 `size`(px) + minSize/maxSize(resize
 * 边界)；弹性列(preview/response)与 session gutter 用 `enableResizing:false` 且不设 size
 * (自适应剩余空间 / HistoryList 特判 10px)。
 */
export const REQUEST_COLUMNS: Array<ColumnDef<EntrySummary>> = [
  {
    id: "session",
    header: "",
    cell: () => null, // 实际色块在 HistoryList itemContent 首列特判渲染(审查:ColumnDef.cell 拿不到 runs)
    enableResizing: false, // gutter：宽度靠 HistoryList 特判 p-0 w-[10px]，不设 size、排除出 sizing
  },
  {
    id: "status",
    header: "Status",
    accessorFn: (e) => requestState(e),
    cell: ({ row }) => {
      const state = requestState(row.original)
      return span(ELLIPSIS, `● ${state}`, { color: SIGNAL_COLOR[statusSignal(state)] })
    },
    size: 92,
    minSize: 60,
    maxSize: 160,
  },
  {
    id: "time",
    header: "Time",
    accessorFn: (e) => e.startedAt,
    cell: ({ row }) => span("text-[#777]", formatTime(row.original.startedAt), { title: new Date(row.original.startedAt).toISOString() }),
    size: 68,
    minSize: 56,
    maxSize: 120,
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
    size: 64,
    minSize: 48,
    maxSize: 120,
  },
  {
    id: "model",
    header: "Model",
    accessorFn: (e) => modelName(e),
    cell: ({ row }) => span(`${ELLIPSIS} text-[#cdb]`, modelName(row.original), { title: modelName(row.original) }),
    size: 180,
    minSize: 80,
    maxSize: 360,
  },
  {
    id: "cache",
    header: "Cache",
    accessorFn: (e) => cacheHitCell(e).text,
    cell: ({ row }) => {
      const c = cacheHitCell(row.original)
      return span(`${ELLIPSIS} text-right`, c.text, { color: SIGNAL_COLOR[c.signal], title: c.title })
    },
    size: 64,
    minSize: 44,
    maxSize: 120,
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
    size: 34,
    minSize: 28,
    maxSize: 48,
  },
  {
    id: "endpoint",
    header: "Endpoint",
    accessorFn: (e) => endpointLabel(e),
    cell: ({ row }) => span(`${ELLIPSIS} text-[#777]`, endpointLabel(row.original), { title: endpointLabel(row.original) }),
    size: 120,
    minSize: 60,
    maxSize: 240,
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
    size: 118,
    minSize: 70,
    maxSize: 200,
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
    size: 130,
    minSize: 80,
    maxSize: 220,
  },
  {
    id: "attempts",
    header: "Att",
    accessorFn: (e) => e.attemptCount ?? 1,
    cell: ({ row }) => {
      const n = row.original.attemptCount
      return span("text-right text-[#a87]", n && n > 1 ? `×${n}` : "")
    },
    size: 40,
    minSize: 32,
    maxSize: 80,
  },
  {
    id: "preview",
    header: "Request",
    accessorFn: (e) => (requestState(e) === "completed" ? truncPreview(e) : failureSummary(e)),
    cell: ({ row }) => {
      const e = row.original
      const completed = requestState(e) === "completed"
      const title = completed ? e.previewText || truncPreview(e) : failureSummary(e)
      const className = completed ? `${ELLIPSIS} text-[#8a8a7a]` : `${ELLIPSIS} text-[var(--color-fail)]`
      return span(className, completed ? truncPreview(e) : failureSummary(e), { title })
    },
    enableResizing: false, // 弹性列：吃满剩余空间，不设 size、不 emit inline width
  },
  {
    id: "response",
    header: "Response",
    accessorFn: (e) => truncResponsePreview(e),
    cell: ({ row }) => {
      const e = row.original
      return span(`${ELLIPSIS} text-[#8a9a8a]`, truncResponsePreview(e), { title: e.responsePreviewText || "" })
    },
    enableResizing: false, // 弹性列：吃满剩余空间，不设 size、不 emit inline width
  },
]

/** 列 id 顺序(单一来源，供可见性默认/对账/菜单迭代)。 */
export const REQUEST_COLUMN_IDS: ReadonlyArray<string> = REQUEST_COLUMNS.map((c) => c.id as string)

/** 版本化 localStorage 键 —— Requests 列表的统一列状态(visibility + sizing + order)。旧键 `ui-v4:requests:columns` 已弃用(新键不存在→从新默认 seed)。 */
export const COLUMN_STATE_KEY = "ui-v4:requests:column-state:v1"

/** 默认隐藏列:endpoint/multiplier/tokens/attempts(策展默认视图,余含 cache 皆显)。 */
const DEFAULT_HIDDEN = new Set(["endpoint", "multiplier", "tokens", "attempts"])

/** 列默认可见性:DEFAULT_HIDDEN 内为 false，余为 true。 */
export const DEFAULT_COLUMN_VISIBILITY: VisibilityState = Object.fromEntries(REQUEST_COLUMN_IDS.map((id) => [id, !DEFAULT_HIDDEN.has(id)]))

/** 默认列序(session 恒首;cache 紧随 model)。持久序缺失/新列时的补位基准。 */
export const DEFAULT_COLUMN_ORDER: ReadonlyArray<string> = [
  "session",
  "status",
  "time",
  "dur",
  "model",
  "cache",
  "bytes",
  "preview",
  "response",
  "endpoint",
  "multiplier",
  "tokens",
  "attempts",
]

/** 默认列宽(px):仅固定列(enableResizing !== false 且自带 size)入表;弹性列/session 不在内(宽度自适应/特判)。 */
export const DEFAULT_COLUMN_SIZING: Record<string, number> = Object.fromEntries(
  REQUEST_COLUMNS.filter((c) => c.enableResizing !== false && typeof c.size === "number").map((c) => [c.id as string, c.size as number]),
)

/**
 * 把持久化的可见性 blob 合并到默认之上:未知/缺失列取默认(retain-on-absence
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

/** 持久序为基 + 新列按默认序补位 + 删列忽略 + session 恒首。 */
export function mergeColumnOrder(persisted: ReadonlyArray<string> | null | undefined): Array<string> {
  const known = new Set(REQUEST_COLUMN_IDS)
  const base = (persisted ?? []).filter((id) => known.has(id))
  for (const id of DEFAULT_COLUMN_ORDER) if (!base.includes(id)) base.push(id) // 新列补位
  return ["session", ...base.filter((id) => id !== "session")] // session 锁首
}

/** 持久值覆盖 + 未知列丢弃 + 新列取默认 size。 */
export function mergeColumnSizing(persisted: Record<string, number> | null | undefined): Record<string, number> {
  const merged = { ...DEFAULT_COLUMN_SIZING }
  if (persisted && typeof persisted === "object")
    for (const id of Object.keys(DEFAULT_COLUMN_SIZING)) if (typeof persisted[id] === "number") merged[id] = persisted[id]
  return merged
}
