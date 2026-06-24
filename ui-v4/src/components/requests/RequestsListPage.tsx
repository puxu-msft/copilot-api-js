import { HistoryList } from "@/components/requests/HistoryList"
import { LiveLane } from "@/components/requests/LiveLane"
import { useLiveRequests } from "@/hooks/useLiveRequests"

/** Requests 列表全屏页(Plan 08 §1):Live 泳道 + History 列表占满主内容区。 */
export function RequestsListPage() {
  useLiveRequests() // 订阅 WS active 事件喂 live-store(挂一次)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <LiveLane />
      <HistoryList />
    </div>
  )
}
