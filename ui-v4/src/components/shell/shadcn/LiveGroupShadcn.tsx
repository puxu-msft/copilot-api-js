import { memo } from "react"

import type { LiveGroupData } from "@/lib/live-summary"
import type { LiveEntry } from "@/stores/live-store"

import { formatDuration } from "@/lib/format"

/**
 * LiveDock 分组明细(shadcn 侧)—— legacy `LiveGroup`/`LiveDetailRow` 的中性化孪生(读同一 `LiveEntry`,
 * 数据源不 fork)。配色走中性 shadcn token;圆角随 `--radius`。live 信号色(绿/琥珀)是**交用户 UX 检查项**
 * (此处 in-flight/streaming 用 `text-primary`、retrying 用 `text-muted-foreground`)。legacy `LiveGroup` 冻结、Z1 才删。
 */
const ROW_CLASS = "mono flex w-full items-center gap-2 border-b border-border px-2 py-1 text-left text-xs"

function modelLabel(row: LiveEntry): string {
  if (row.resolvedModel && row.clientModel && row.resolvedModel !== row.clientModel) return `${row.clientModel}→${row.resolvedModel}`
  return row.resolvedModel ?? row.model ?? row.clientModel ?? "—"
}

const LiveDetailRowShadcn = memo(function LiveDetailRowShadcn({ row, nowMs, onSelect }: { row: LiveEntry; nowMs: number; onSelect: (id: string) => void }) {
  const elapsed = formatDuration(Math.max(0, nowMs - row.startTime))
  const attempt = row.attemptCount && row.attemptCount > 1 ? `×${row.attemptCount}` : ""
  const queue = row.queueWaitMs && row.queueWaitMs > 100 ? `q:${formatDuration(row.queueWaitMs)}` : ""
  return (
    <button
      type="button"
      onClick={() => onSelect(row.id)}
      className={`${ROW_CLASS} text-foreground hover:bg-muted`}
    >
      <span className="w-[84px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-primary">◐ {row.state}</span>
      <span className="w-[52px] shrink-0 text-right text-muted-foreground">{elapsed}</span>
      <span
        className="w-[78px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground"
        title={row.endpoint}
      >
        {row.endpoint}
      </span>
      <span
        className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-foreground"
        title={modelLabel(row)}
      >
        {modelLabel(row)}
      </span>
      {attempt ?
        <span className="shrink-0 text-primary">
          {attempt} {row.currentStrategy ?? ""}
        </span>
      : null}
      {queue ?
        <span className="shrink-0 text-muted-foreground">{queue}</span>
      : null}
      {row.stream ?
        <span
          className="shrink-0 text-primary"
          title="streaming"
        >
          ⚡
        </span>
      : null}
      {row.requestBodySize ?
        <span
          className="shrink-0 text-muted-foreground"
          title="request bytes"
        >
          {Math.round(row.requestBodySize / 1024)}k
        </span>
      : null}
      {row.transport ?
        <span
          className="shrink-0 text-muted-foreground"
          title="transport"
        >
          {row.transport}
        </span>
      : null}
      {row.retry?.willRetry ?
        <span
          className="shrink-0 text-muted-foreground"
          title="retrying"
        >
          ↻ next:{row.retry.nextStrategy ?? "?"} 等{formatDuration(row.retry.waitMs)}
        </span>
      : null}
      {row.features?.map((f, i) => (
        <span
          key={`${f.feature}-${i}`}
          className="shrink-0 text-muted-foreground"
          title={f.feature}
        >
          {f.feature}
        </span>
      ))}
    </button>
  )
})

/** 一组(同 resolved model)—— 组头(showHeader 时)+ oldest-first 明细行。中性化孪生。 */
export function LiveGroupShadcn({
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
        <div className="mono flex items-center gap-2 border-b border-border bg-muted/40 px-2 py-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">
          <span className="text-foreground">{group.model}</span>
          <span>×{group.count}</span>
          {group.streaming > 0 ?
            <span className="text-primary">⚡{group.streaming}</span>
          : null}
          <span className="ml-auto">oldest {formatDuration(group.oldestElapsedMs)}</span>
        </div>
      : null}
      {group.rows.map((r) => (
        <LiveDetailRowShadcn
          key={r.id}
          row={r}
          nowMs={nowMs}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}
