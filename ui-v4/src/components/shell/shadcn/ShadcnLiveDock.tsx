import { useMemo } from "react"

import { useNowTick } from "@/hooks/useNowTick"
import { formatDuration } from "@/lib/format"
import { summarizeLive } from "@/lib/live-summary"
import { useLiveStore } from "@/stores/live-store"

/**
 * fork C · shadcn LiveDock 呈现层骨架。C6 只搭机制 + 最小骨架。
 *
 * 关键:读**同一常驻 live-store**(`useLiveStore`)—— fork 的是**呈现层**,数据源不 fork,
 * 故切换 designVersion 不丢在飞请求(INV-FIDELITY-1:一次性 connected 快照由 L0 的 useLiveRequests
 * 维护进 live-store,两版呈现层都读它)。中性语义 token,圆角随 `--radius`。
 * `data-testid=dock-shadcn` 供 INV-2 互斥挂载守卫。
 *
 * 逐页打磨(展开面板 / tail 控件 / 分组明细)留后续 plan;此处最小:idle/在途摘要条。
 */
export function ShadcnLiveDock(): React.ReactElement {
  const byId = useLiveStore((s) => s.byId)
  const rows = useMemo(() => Object.values(byId), [byId])
  const active = rows.length > 0
  const nowMs = useNowTick(active)
  const summary = useMemo(() => summarizeLive(rows, nowMs), [rows, nowMs])
  return (
    <div
      data-testid="dock-shadcn"
      className="fixed inset-x-3 bottom-3 z-40 flex h-8 items-center gap-2 overflow-hidden rounded-lg border border-border bg-card px-3 text-sm whitespace-nowrap text-card-foreground shadow-xl"
    >
      {active ?
        <>
          <span className="shrink-0 text-primary">● {summary.count} in-flight</span>
          {summary.streaming > 0 ?
            <span className="shrink-0 text-primary">⚡{summary.streaming} streaming</span>
          : null}
          {summary.retrying > 0 ?
            <span className="shrink-0 text-muted-foreground">↻{summary.retrying} retrying</span>
          : null}
          <span className="shrink-0 text-muted-foreground">oldest {formatDuration(summary.oldestElapsedMs)}</span>
        </>
      : <span className="text-muted-foreground">○ idle · 0 in-flight</span>}
    </div>
  )
}
