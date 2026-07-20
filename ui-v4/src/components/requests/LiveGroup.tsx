import { memo } from "react"

import type { LiveGroupData } from "@/lib/live-summary"
import type {
  //
  LiveEntry,
} from "@/stores/live-store"

import { formatDuration } from "@/lib/format"

// 浮岛内配色统一走 amber/中性 token(不用 SIGNAL_COLOR 绿):在途状态全是 live,amber 点足够,
// 全站 History 的信号绿(SIGNAL_COLOR)保持不变。
const ROW_CLASS = "mono flex w-full items-center gap-2 border-b border-[var(--color-border)] px-2 py-1 text-left text-[12px]"

function modelLabel(row: LiveEntry): string {
  if (row.resolvedModel && row.clientModel && row.resolvedModel !== row.clientModel) return `${row.clientModel}→${row.resolvedModel}`
  return row.resolvedModel ?? row.model ?? row.clientModel ?? "—"
}

/**
 * 单请求富明细行 —— memo 只挡 NON-tick 重渲(如别的行 byId 变化时不重渲本行)。
 * 当前可见行仍会每秒随共享 nowMs 刷新 elapsed 文本:这是单一共享 ticker 设计的固有代价,
 * 对有界的在途行数很廉价 —— 不引入 per-row 计时器(1 个共享 ticker 才是既定设计)。
 * memo 生效前提:onSelect 必须由父级稳定传入(见 LiveDock 的 useCallback)。
 */
export const LiveDetailRow = memo(function LiveDetailRow({ row, nowMs, onSelect }: { row: LiveEntry; nowMs: number; onSelect: (id: string) => void }) {
  const elapsed = formatDuration(Math.max(0, nowMs - row.startTime))
  const attempt = row.attemptCount && row.attemptCount > 1 ? `×${row.attemptCount}` : ""
  const queue = row.queueWaitMs && row.queueWaitMs > 100 ? `q:${formatDuration(row.queueWaitMs)}` : ""
  return (
    <button
      type="button"
      onClick={() => onSelect(row.id)}
      className={`${ROW_CLASS} text-[var(--color-text)]`}
    >
      <span className="w-[84px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--color-primary)]">◐ {row.state}</span>
      <span className="w-[52px] shrink-0 text-right text-[var(--color-muted)]">{elapsed}</span>
      <span
        className="w-[78px] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--color-muted)]"
        title={row.endpoint}
      >
        {row.endpoint}
      </span>
      <span
        className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--color-text)]"
        title={modelLabel(row)}
      >
        {modelLabel(row)}
      </span>
      {attempt ?
        <span className="shrink-0 text-[var(--color-primary)]">
          {attempt} {row.currentStrategy ?? ""}
        </span>
      : null}
      {queue ?
        <span className="shrink-0 text-[var(--color-muted)]">{queue}</span>
      : null}
      {row.stream ?
        <span
          className="shrink-0 text-[var(--color-primary)]"
          title="streaming"
        >
          ⚡
        </span>
      : null}
      {row.requestBodySize ?
        <span
          className="shrink-0 text-[var(--color-muted)]"
          title="request bytes"
        >
          {Math.round(row.requestBodySize / 1024)}k
        </span>
      : null}
      {row.transport ?
        <span
          className="shrink-0 text-[var(--color-muted)]"
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
      {row.features?.map((f, i) => (
        <span
          key={`${f.feature}-${i}`}
          className="shrink-0 text-[var(--color-muted)]"
          title={f.feature}
        >
          {f.feature}
        </span>
      ))}
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
        <div className="mono flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[11px] uppercase tracking-wider text-[var(--color-muted)]">
          <span className="text-[var(--color-text)]">{group.model}</span>
          <span>×{group.count}</span>
          {group.streaming > 0 ?
            <span className="text-[var(--color-primary)]">⚡{group.streaming}</span>
          : null}
          <span className="ml-auto">oldest {formatDuration(group.oldestElapsedMs)}</span>
        </div>
      : null}
      {group.rows.map((r) => (
        <LiveDetailRow
          key={r.id}
          row={r}
          nowMs={nowMs}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}
