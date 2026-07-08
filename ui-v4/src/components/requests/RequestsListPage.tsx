import type { VisibilityState } from "@tanstack/react-table"

import {
  //
  useCallback,
  useEffect,
  useState,
} from "react"

import { HistoryList } from "@/components/requests/HistoryList"
import { LiveLane } from "@/components/requests/LiveLane"
import { RequestFilterChips } from "@/components/requests/RequestFilterChips"
import { RequestsColumnMenu } from "@/components/requests/RequestsColumnMenu"
import { RequestsFilterBar } from "@/components/requests/RequestsFilterBar"
import { useLiveRequests } from "@/hooks/useLiveRequests"
import { useRequestFilters } from "@/hooks/useRequestFilters"
import {
  //
  COLUMN_STORAGE_KEY,
  DEFAULT_COLUMN_VISIBILITY,
  mergeColumnVisibility,
} from "@/lib/request-columns"

/** 从 localStorage 读列可见性,容错(JSON 解析失败 / storage 不可用 → 默认全显);mergeColumnVisibility 对账未知/缺失列。 */
function loadColumnVisibility(): VisibilityState {
  try {
    return mergeColumnVisibility(JSON.parse(localStorage.getItem(COLUMN_STORAGE_KEY) ?? "null") as Partial<VisibilityState> | null)
  } catch {
    return { ...DEFAULT_COLUMN_VISIBILITY }
  }
}

/** Requests 列表全屏页(Plan 08 §1):筛选工具条 + 活动 chips + Live 泳道 + History 列表。 */
export function RequestsListPage() {
  useLiveRequests() // 订阅 WS active 事件喂 live-store(挂一次)
  const { filters, setFilter, setFilters, clearFilter, clearAll } = useRequestFilters()

  // 列可见性提到 Page(单一持有者):菜单驱动 + localStorage 持久化,HistoryList 受控消费。
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(loadColumnVisibility)
  useEffect(() => {
    // localStorage 写入可能抛(隐私模式 / 禁用)—— 不阻塞渲染,吞并记 warn(内部工具可观测性)。
    try {
      localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(columnVisibility))
    } catch (err) {
      console.warn("[RequestsListPage] 列可见性持久化失败:", err)
    }
  }, [columnVisibility])

  const toggleColumn = useCallback((id: string) => setColumnVisibility((c) => ({ ...c, [id]: !(c[id] ?? true) })), [])
  const resetColumns = useCallback(() => setColumnVisibility({ ...DEFAULT_COLUMN_VISIBILITY }), [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <RequestsFilterBar
        filters={filters}
        setFilter={setFilter}
        setFilters={setFilters}
        columnMenuSlot={
          <RequestsColumnMenu
            columns={columnVisibility}
            onToggle={toggleColumn}
            onReset={resetColumns}
          />
        }
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
        columnVisibility={columnVisibility}
        onColumnVisibilityChange={setColumnVisibility}
        onClearFilters={clearAll}
      />
    </div>
  )
}
