import { DetailPlaceholder } from "@/components/requests/DetailPlaceholder"
import { HistoryList } from "@/components/requests/HistoryList"
import { LiveLane } from "@/components/requests/LiveLane"
import { useLiveRequests } from "@/hooks/useLiveRequests"

/** Requests 工作台 —— 主从一体(spec §4):左 Live 泳道+History 列表,右 详情。 */
export function RequestsWorkbench() {
  useLiveRequests() // 订阅 WS active 事件喂 live-store(挂一次)
  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-h-0 w-[38%] min-w-[280px] flex-col border-r border-[var(--color-border)]">
        <LiveLane />
        <HistoryList />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <DetailPlaceholder />
      </div>
    </div>
  )
}
