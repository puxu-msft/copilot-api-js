import {
  //
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers"

import { HistoryList } from "@/components/requests/HistoryList"
import { RequestFilterChips } from "@/components/requests/RequestFilterChips"
import { RequestsColumnMenu } from "@/components/requests/RequestsColumnMenu"
import { RequestsFilterBar } from "@/components/requests/RequestsFilterBar"
import { useColumnState } from "@/hooks/useColumnState"
import { useRequestFilters } from "@/hooks/useRequestFilters"
import { reorderColumns } from "@/lib/request-columns"

/**
 * Requests 列表全屏页 legacy 侧(Terminal Amber,冻结不动,Z1 才删)——原 `RequestsListPage` body
 * 逐字搬来:筛选工具条 + 活动 chips + History 列表 + master 列配置三态(dnd 重排 / resize / 可见性)。
 * 在途浮窗 LiveDock 已全局化到 AppShell。P2 起 `RequestsListPage` 变薄 `DesignFork` wrapper,
 * shadcn 侧见 `RequestsListShadcn`。
 */
export function RequestsListLegacy() {
  // 在途订阅 + LiveDock 浮窗均已提升到 AppShell(常驻根、全局可见);此处只渲染请求列表本体。
  const { filters, setFilter, setFilters, clearFilter, clearAll } = useRequestFilters()

  // 列状态(visibility + sizing + order)提到 Page(单一持有者):版本化统一键持久化,菜单/HistoryList 受控消费。
  // 三态皆已通到 table;dnd 重排(本 Task)经 DndContext.onDragEnd → reorderColumns → cs.setOrder(内部再过 mergeColumnOrder 幂等锁首)。
  const cs = useColumnState()

  // dnd 列序重排:PointerSensor + activationConstraint distance:4(HIGH-2)——微动/点击不误判拖拽,且与 resize 手柄
  // (已 onPointerDown stopPropagation)分区。restrictToHorizontalAxis 锁水平位移(列表头只沿横轴重排)。
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) cs.setOrder((o) => reorderColumns(o, String(active.id), String(over.id)))
  }

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
      <DndContext
        sensors={sensors}
        modifiers={[restrictToHorizontalAxis]}
        onDragEnd={onDragEnd}
      >
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
      </DndContext>
    </div>
  )
}
