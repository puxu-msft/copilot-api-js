import type {
  //
  OnChangeFn,
  SortingState,
  VisibilityState,
} from "@tanstack/react-table"
import type { Model } from "~backend/lib/models/client"

import {
  //
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { useMemo } from "react"

import type { ModelStatus } from "@/lib/model-status"
import type { JoinedModelTelemetry } from "@/lib/model-telemetry"

import {
  //
  ariaSortAttr,
  augmentRows,
  buildModelColumns,
  sortCaret,
} from "@/components/models/model-table-columns"

interface ModelsTableShadcnProps {
  models: Array<Model>
  columnVisibility: VisibilityState
  sorting: SortingState
  onSortingChange: OnChangeFn<SortingState>
  telemetryFor: (id: string) => JoinedModelTelemetry | null
  statusFor: (model: Model) => ModelStatus
  maxRequests7d: number
  selectedId?: string | null
  onSelect?: (id: string) => void
}

/**
 * Models 数据表(shadcn 侧)—— TanStack Table 列模型,复用**共用列构建器** `buildModelColumns`/`augmentRows`
 * (已 C2 中性化,两树共用:列身份/accessor/排序语义/cell 渲染的单一来源)。TanStack 仍拥有 sorting +
 * columnVisibility(受控,提到 `ModelsShadcn`);本文件只重写中性 `<table>` 外壳 class(neutral token 替
 * legacy amber)。legacy `ModelsTable` 冻结、Z1 才删。
 */
export function ModelsTableShadcn({
  models,
  columnVisibility,
  sorting,
  onSortingChange,
  telemetryFor,
  statusFor,
  maxRequests7d,
  selectedId,
  onSelect,
}: ModelsTableShadcnProps) {
  const data = useMemo(() => augmentRows(models, telemetryFor, statusFor), [models, telemetryFor, statusFor])
  const columns = useMemo(() => buildModelColumns({ maxRequests7d, onSelect }), [maxRequests7d, onSelect])

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnVisibility },
    onSortingChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <table className="mono w-full text-[12px]">
      <thead className="sticky top-0 z-[1] bg-card">
        {table.getHeaderGroups().map((hg) => (
          <tr key={hg.id}>
            {hg.headers.map((h) => {
              const canSort = h.column.getCanSort()
              const sorted = h.column.getIsSorted()
              const label = flexRender(h.column.columnDef.header, h.getContext())
              return (
                <th
                  key={h.id}
                  scope="col"
                  aria-sort={canSort ? ariaSortAttr(sorted) : undefined}
                  className={h.column.columnDef.meta?.thClass}
                >
                  {canSort ?
                    <button
                      type="button"
                      onClick={h.column.getToggleSortingHandler()}
                      className="mono cursor-pointer select-none border-0 bg-transparent p-0 uppercase tracking-wider text-inherit hover:text-primary"
                    >
                      {label}
                      {sortCaret(sorted)}
                    </button>
                  : label}
                </th>
              )
            })}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => {
          const selected = row.original.model.id === selectedId
          const muted = row.original.status === "config-disabled"
          return (
            <tr
              key={row.id}
              className={`border-b border-border ${onSelect ? "cursor-pointer hover:bg-muted/60" : ""} ${muted ? "text-muted-foreground" : ""} ${selected ? "border-l-2 border-l-primary bg-accent text-accent-foreground" : ""}`}
              aria-current={selected ? "true" : undefined}
              onClick={onSelect ? () => onSelect(row.original.model.id) : undefined}
            >
              {row.getVisibleCells().map((cell) => (
                <td
                  key={cell.id}
                  className={cell.column.columnDef.meta?.tdClass ?? "px-2 py-1"}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
