import { StatCard } from "@/components/overview/StatCard"
import {
  //
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useStatus } from "@/hooks/useStatus"
import { formatDuration } from "@/lib/format"
import { useLiveStore } from "@/stores/live-store"

/**
 * fork B · Overview shadcn 页元素(P1 完整版)。
 *
 * 与 legacy(`OverviewLegacy`)读**同一数据源**(`useStatus` / live-store),仅呈现层不同:
 *  - 健康指标复用 **B 内容体 `StatCard`**(C3 中性化,两树共用),与 legacy 6 项齐平(parity)。
 *  - 深度服务信息段(version / uptime / models / backend / shutdown)按 richest-data-flow 呈现
 *    `useStatus` 已可得的字段(后端 `/api/status` 全量返回,前端择要显示)。
 *  - 深度分析入口是**真链接** → `/metrics`(Prometheus 端点,同源暴露;Grafana 消费之)。
 * 全部走中性语义 token + shadcn `Card`,圆角随 `--radius`。`data-testid=overview-shadcn` 供
 * fork B 互斥挂载守卫。
 */
export function OverviewShadcn() {
  const { data, isLoading } = useStatus()
  const liveCount = useLiveStore((s) => Object.keys(s.byId).length)
  if (isLoading) return <div className="p-4 text-muted-foreground">loading…</div>

  const rl = data?.rateLimiter as { mode?: string; enabled?: boolean } | undefined
  const quota = data?.quota as { status?: string } | undefined
  const memory = data?.memory as { historyEntryCount?: number; inFlightCount?: number; historyBackend?: string } | undefined
  const ws = data?.upstream_ws as { enabled?: boolean; active_connections?: number } | undefined
  const models = data?.models as { totalCount?: number; availableCount?: number } | undefined
  const shutdown = data?.shutdown as { phase?: string } | undefined
  const uptime = typeof data?.uptime === "number" ? data.uptime : undefined

  const cards: ReadonlyArray<{ label: string; value: string | number; sub?: string }> = [
    { label: "In-flight", value: liveCount, sub: "实时 · WS" },
    { label: "Rate limiter", value: rl?.enabled ? (rl.mode ?? "on") : "off" },
    { label: "Quota", value: quota?.status ?? "—" },
    { label: "Active (server)", value: data?.activeRequests?.count ?? "—" },
    {
      label: "History entries",
      value: memory?.historyEntryCount ?? "—",
      sub: memory?.inFlightCount === undefined ? undefined : `${memory.inFlightCount} in-flight`,
    },
    {
      label: "Upstream WS",
      value: ws?.enabled ? "on" : "off",
      sub: ws?.active_connections === undefined ? undefined : `${ws.active_connections} conn`,
    },
  ]

  const info: ReadonlyArray<{ label: string; value: string }> = [
    { label: "Version", value: data?.version ?? "—" },
    { label: "Uptime", value: uptime === undefined ? "—" : formatDuration(uptime * 1000) },
    { label: "Models", value: models === undefined ? "—" : `${models.availableCount ?? "—"} / ${models.totalCount ?? "—"}` },
    { label: "History backend", value: memory?.historyBackend ?? "—" },
    { label: "Shutdown", value: shutdown?.phase ?? "—" },
  ]

  return (
    <div
      data-testid="overview-shadcn"
      className="flex flex-col gap-4 p-1 text-foreground"
    >
      <Card>
        <CardHeader>
          <CardTitle>Server health</CardTitle>
          <CardDescription>实时健康指标(与 live-store / /api/status 同源)。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {cards.map((c) => (
              <StatCard
                key={c.label}
                label={c.label}
                value={c.value}
                sub={c.sub}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Server info</CardTitle>
          <CardDescription>版本 / 运行时长 / 模型可用度 / 关停阶段。</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-5">
            {info.map((row) => (
              <div
                key={row.label}
                className="flex flex-col gap-0.5"
              >
                <dt className="text-xs text-muted-foreground">{row.label}</dt>
                <dd className="font-medium tabular-nums">{row.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>深度分析</CardTitle>
          <CardDescription>历史请求量 / token / cost 趋势、跨窗口维度 breakdown。</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Grafana 消费 Prometheus 指标(<code className="rounded bg-muted px-1 py-0.5 text-xs">copilot_api_*_total</code>）。原始指标见{" "}
          <a
            href="/metrics"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            /metrics
          </a>
          。
        </CardContent>
      </Card>
    </div>
  )
}
