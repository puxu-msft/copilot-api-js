import { StatCard } from "@/components/overview/StatCard"
import { useStatus } from "@/hooks/useStatus"
import { useLiveStore } from "@/stores/live-store"

export function OverviewPage() {
  const { data, isLoading } = useStatus()
  const liveCount = useLiveStore((s) => Object.keys(s.byId).length)
  if (isLoading) return <div className="mono p-4 text-[#888]">loading…</div>
  const rl = data?.rateLimiter as { mode?: string; enabled?: boolean } | undefined
  const quota = data?.quota as { status?: string } | undefined
  const memory = data?.memory as { historyEntryCount?: number; inFlightCount?: number } | undefined
  const ws = data?.upstream_ws as { enabled?: boolean; active_connections?: number } | undefined
  return (
    <div className="mono flex flex-col gap-4 p-2">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="In-flight"
          value={liveCount}
          sub="实时 · WS"
        />
        <StatCard
          label="Rate limiter"
          value={rl?.enabled ? (rl.mode ?? "on") : "off"}
        />
        <StatCard
          label="Quota"
          value={quota?.status ?? "—"}
        />
        <StatCard
          label="Active (server)"
          value={data?.activeRequests?.count ?? "—"}
        />
        <StatCard
          label="History entries"
          value={memory?.historyEntryCount ?? "—"}
          sub={memory?.inFlightCount === undefined ? undefined : `${memory.inFlightCount} in-flight`}
        />
        <StatCard
          label="Upstream WS"
          value={ws?.enabled ? "on" : "off"}
          sub={ws?.active_connections === undefined ? undefined : `${ws.active_connections} conn`}
        />
      </div>
      <div className="border border-dashed border-[#2f4a6f] bg-[#10161f] p-3 text-[13px]">
        <div className="text-[#9ad]">📊 深度分析见 Grafana（消费 /metrics）</div>
        <div className="text-[12px] text-[#5a7a9a]">历史请求量 / token / cost 趋势、跨窗口维度 breakdown — copilot_api_*_total 已由 /metrics 暴露。</div>
      </div>
    </div>
  )
}
