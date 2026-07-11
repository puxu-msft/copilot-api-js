import { useStatus } from "@/hooks/useStatus"
import { useLiveStore } from "@/stores/live-store"

/**
 * fork B · Overview shadcn 页元素**骨架**(C6 最小示范)。C6 只搭 fork B 机制 + 一个示范页壳,
 * 逐页内容打磨留 P1(Overview)。用 shadcn Card 布局 + 中性语义 token,圆角随 `--radius`。
 * 与 legacy 读同一数据源(useStatus / live-store),仅呈现层不同。
 */
export function OverviewShadcn() {
  const { data, isLoading } = useStatus()
  const liveCount = useLiveStore((s) => Object.keys(s.byId).length)
  if (isLoading) return <div className="p-4 text-muted-foreground">loading…</div>
  const rl = data?.rateLimiter as { mode?: string; enabled?: boolean } | undefined
  const quota = data?.quota as { status?: string } | undefined
  const memory = data?.memory as { historyEntryCount?: number } | undefined
  const cards: ReadonlyArray<{ label: string; value: string | number }> = [
    { label: "In-flight", value: liveCount },
    { label: "Rate limiter", value: rl?.enabled ? (rl.mode ?? "on") : "off" },
    { label: "Quota", value: quota?.status ?? "—" },
    { label: "Active (server)", value: data?.activeRequests?.count ?? "—" },
    { label: "History entries", value: memory?.historyEntryCount ?? "—" },
  ]
  return (
    <div className="flex flex-col gap-4 p-1 text-foreground">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {cards.map((c) => (
          <div
            key={c.label}
            className="rounded-lg border border-border bg-card p-3"
          >
            <div className="text-xs text-muted-foreground">{c.label}</div>
            <div className="mt-1 text-lg font-semibold">{c.value}</div>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        shadcn 骨架 · Overview 逐页打磨留 P1(深度分析见 Grafana，消费 /metrics）。
      </div>
    </div>
  )
}
