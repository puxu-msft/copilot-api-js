import { HistoryList } from "@/components/requests/HistoryList"
import { LiveLane } from "@/components/requests/LiveLane"
import { RequestFilterChips } from "@/components/requests/RequestFilterChips"
import { RequestsFilterBar } from "@/components/requests/RequestsFilterBar"
import { useLiveRequests } from "@/hooks/useLiveRequests"
import { useRequestFilters } from "@/hooks/useRequestFilters"

/** Requests 列表全屏页(Plan 08 §1):筛选工具条 + 活动 chips + Live 泳道 + History 列表。 */
export function RequestsListPage() {
  useLiveRequests() // 订阅 WS active 事件喂 live-store(挂一次)
  const { filters, setFilter, setFilters, clearFilter, clearAll } = useRequestFilters()
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* columnMenuSlot 本阶段传 null,Phase 3 Task 3.4 接入列可见性菜单。 */}
      <RequestsFilterBar
        filters={filters}
        setFilter={setFilter}
        setFilters={setFilters}
        columnMenuSlot={null}
      />
      <RequestFilterChips
        filters={filters}
        clearFilter={clearFilter}
        clearAll={clearAll}
        setFilters={setFilters}
      />
      <LiveLane />
      <HistoryList
        filters={filters}
        onClearFilters={clearAll}
      />
    </div>
  )
}
