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

import type { JoinedModelTelemetry } from "@/lib/model-telemetry"

import {
  //
  ariaSortAttr,
  augmentRows,
  buildModelColumns,
  sortCaret,
} from "./model-table-columns"

interface ModelsTableProps {
  models: Array<Model>
  /** Controlled column visibility (keys are `ModelColumnKey`) — owned by ModelsPage/column menu. */
  columnVisibility: VisibilityState
  /** Controlled sort state — lifted to ModelsPage so the CSV export sorts identically. */
  sorting: SortingState
  onSortingChange: OnChangeFn<SortingState>
  telemetryFor: (id: string) => JoinedModelTelemetry | null
  maxRequests7d: number
  selectedId?: string | null
  onSelect?: (id: string) => void
}

/**
 * Models data table on **TanStack Table** (headless-component-stack ADR). TanStack
 * owns sorting (`getSortedRowModel`, numeric desc-first) and column visibility
 * (`VisibilityState`); this component only renders the Terminal Amber `<table>` —
 * headless means we emit the exact same markup/classes as the hand-written version.
 *
 * Sorting + visibility state are CONTROLLED (lifted to ModelsPage) so the CSV export
 * can sort the same rows with the same {@link sortModelRows} accessor → identical order.
 * Column identity, accessors, sort semantics, and cell rendering live in the shared
 * {@link ./model-table-columns} module (the single accessor source).
 */
export function ModelsTable({ models, columnVisibility, sorting, onSortingChange, telemetryFor, maxRequests7d, selectedId, onSelect }: ModelsTableProps) {
  const data = useMemo(() => augmentRows(models, telemetryFor), [models, telemetryFor])
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
      <thead className="sticky top-0 z-[1] bg-[var(--color-bg)]">
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
                  // Sortable headers convey sort state (WCAG 1.3.1); non-sortable ones omit aria-sort.
                  aria-sort={canSort ? ariaSortAttr(sorted) : undefined}
                  className={h.column.columnDef.meta?.thClass}
                >
                  {canSort ?
                    // Keyboard-operable <button> inside the columnheader (WCAG 2.1.1).
                    <button
                      type="button"
                      onClick={h.column.getToggleSortingHandler()}
                      className="mono cursor-pointer select-none border-0 bg-transparent p-0 uppercase tracking-wider text-inherit hover:text-[var(--color-primary)]"
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
          return (
            <tr
              key={row.id}
              className={`border-b border-[#1e1e24] ${onSelect ? "cursor-pointer hover:bg-[#1a1a20]" : ""} ${selected ? "border-l-2 border-l-[var(--color-primary)] bg-[#3a2f1a]" : ""}`}
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
