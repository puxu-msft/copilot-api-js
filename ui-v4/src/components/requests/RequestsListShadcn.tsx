import {
  //
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers"

import { HistoryListShadcn } from "@/components/requests/HistoryListShadcn"
import { RequestFilterChipsShadcn } from "@/components/requests/RequestFilterChipsShadcn"
import { RequestsColumnMenuShadcn } from "@/components/requests/RequestsColumnMenuShadcn"
import { RequestsFilterBarShadcn } from "@/components/requests/RequestsFilterBarShadcn"
import { useColumnState } from "@/hooks/useColumnState"
import { useRequestFilters } from "@/hooks/useRequestFilters"
import { reorderColumns } from "@/lib/request-columns"

/**
 * fork B · Requests 列表 shadcn 页元素(完整)。壳层中性化(shadcn filter bar / chips / column menu +
 * `HistoryListShadcn`),**重新接线 master 列配置三态**:复用**共用数据层** `useColumnState`(A,含 visibility/
 * sizing/order + merge 纯函数)+ `REQUEST_COLUMNS`(A′,已中性化)+ `reorderColumns`(A),自持 `DndContext`
 * (PointerSensor distance:4 + `restrictToHorizontalAxis`,同 legacy)驱动列头拖拽重排。行点击 → 整页详情
 * (形态 A,`/requests/:id`)、`?at=` 返回定位由 `HistoryListShadcn` 复现。
 * `data-testid=requests-shadcn` 供 fork B 互斥挂载守卫。本文件零设计版本标识符(读取只在 RoutePage 的 `DesignFork`)。
 */
export function RequestsListShadcn() {
  // 在途订阅 + LiveDock 浮窗均已提升到 AppShell(常驻根、全局可见);此处只渲染请求列表本体。
  const { filters, setFilter, setFilters, clearFilter, clearAll } = useRequestFilters()

  // 列状态(visibility + sizing + order)单一持有者:版本化统一键持久化(共用数据层,两树同一 hook)。
  const cs = useColumnState()

  // dnd 列序重排:PointerSensor + activationConstraint distance:4——微动/点击不误判拖拽,与 resize 手柄分区。
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) cs.setOrder((o) => reorderColumns(o, String(active.id), String(over.id)))
  }

  return (
    <div
      data-testid="requests-shadcn"
      className="flex h-full min-h-0 flex-col text-foreground"
    >
      <RequestsFilterBarShadcn
        filters={filters}
        setFilter={setFilter}
        setFilters={setFilters}
        columnMenuSlot={
          <RequestsColumnMenuShadcn
            columns={cs.visibility}
            order={cs.order}
            onToggle={cs.toggleColumn}
            onReset={cs.reset}
          />
        }
      />
      <RequestFilterChipsShadcn
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
        <HistoryListShadcn
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
