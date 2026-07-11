import { HistoryList } from "@/components/requests/HistoryList"
import { RequestFilterChips } from "@/components/requests/RequestFilterChips"
import { RequestsColumnMenu } from "@/components/requests/RequestsColumnMenu"
import { RequestsFilterBar } from "@/components/requests/RequestsFilterBar"
import { useColumnState } from "@/hooks/useColumnState"
import { useRequestFilters } from "@/hooks/useRequestFilters"

/** Requests 列表全屏页(Plan 08 §1):筛选工具条 + 活动 chips + History 列表。在途浮窗 LiveDock 已全局化到 AppShell。 */
export function RequestsListPage() {
  // 在途订阅 + LiveDock 浮窗均已提升到 AppShell(常驻根、全局可见);此处只渲染请求列表本体。
  const { filters, setFilter, setFilters, clearFilter, clearAll } = useRequestFilters()

  // 列状态(visibility + sizing + order)提到 Page(单一持有者):版本化统一键持久化,菜单/HistoryList 受控消费。
  // Task 1 先把三态通到 table,菜单仍只 toggle 显隐;resize 手柄(Task 2)/dnd 重排(Task 3)后续接 setSizing/setOrder。
  const cs = useColumnState()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <RequestsFilterBar
        filters={filters}
        setFilter={setFilter}
        setFilters={setFilters}
        columnMenuSlot={
          <RequestsColumnMenu
            columns={cs.visibility}
            order={cs.order}
            onToggle={cs.toggleColumn}
            onReset={cs.reset}
          />
        }
      />
      <RequestFilterChips
        filters={filters}
        clearFilter={clearFilter}
        clearAll={clearAll}
        setFilters={setFilters}
      />
      <HistoryList
        filters={filters}
        columnVisibility={cs.visibility}
        onColumnVisibilityChange={cs.setVisibility}
        columnSizing={cs.sizing}
        onColumnSizingChange={cs.setSizing}
        columnOrder={cs.order}
        onColumnOrderChange={cs.setOrder}
        onClearFilters={clearAll}
      />
    </div>
  )
}
