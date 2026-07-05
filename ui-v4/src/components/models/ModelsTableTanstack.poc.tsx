import type { DerivedCapabilities } from "~backend/lib/models/capabilities"
import type { Model } from "~backend/lib/models/client"

import {
  //
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table"
import { deriveCapabilities } from "~backend/lib/models/capabilities"
import {
  //
  useMemo,
  useState,
} from "react"

import type { JoinedModelTelemetry } from "@/lib/model-telemetry"

import { formatNumber } from "@/lib/format"

/**
 * PoC (headless-component-stack ADR): a TanStack Table rebuild of ModelsTable.
 *
 * What it proves vs the hand-written version:
 * - **Sorting** (multi-column-capable, typed) is TanStack's — the hand-written
 *   `sortModels` + `sortKey/sortDesc/onSort` plumbing in ModelsPage disappears.
 * - **Column visibility** is TanStack's `VisibilityState` — the hand-written
 *   `ModelColumnVisibility` + toggle logic disappears (menu just drives state).
 * - **Derived + joined columns** (capabilities matrix, telemetry req/7d) are plain
 *   `accessorFn`s — TanStack sorts them correctly with zero extra code.
 * - **Visuals stay 100% self-controlled** (Terminal Amber `<table>` + tokens):
 *   TanStack is headless, so we render the exact same markup/classes. No styled
 *   UI-kit visual conflict.
 */

interface Row {
  model: Model
  caps: DerivedCapabilities
  req: number
}

const col = createColumnHelper<Row>()

const CAPS: ReadonlyArray<{ id: string; key: keyof DerivedCapabilities; label: string }> = [
  { id: "vision", key: "vision", label: "Vis" },
  { id: "toolCalls", key: "toolCalls", label: "Tool" },
  { id: "parallelToolCalls", key: "parallelToolCalls", label: "Par" },
  { id: "structuredOutputs", key: "structuredOutputs", label: "Struct" },
  { id: "streaming", key: "streaming", label: "Strm" },
  { id: "thinking", key: "thinking", label: "Think" },
]

const HEAD = "px-2 py-1 text-left text-[11px] uppercase tracking-wider text-[var(--color-muted)]"

/** TanStack `getIsSorted()` → WAI-ARIA `aria-sort`. */
function ariaSortAttr(s: false | "asc" | "desc"): "ascending" | "descending" | "none" {
  if (s === "asc") return "ascending"
  if (s === "desc") return "descending"
  return "none"
}
/** TanStack `getIsSorted()` → header caret. */
function sortArrow(s: false | "asc" | "desc"): string {
  if (s === "asc") return " ▲"
  if (s === "desc") return " ▼"
  return ""
}

interface Props {
  models: Array<Model>
  telemetryFor: (id: string) => JoinedModelTelemetry | null
  maxRequests7d: number
  columnVisibility: VisibilityState
  selectedId?: string | null
  onSelect?: (id: string) => void
}

export function ModelsTableTanstack({ models, telemetryFor, maxRequests7d, columnVisibility, selectedId, onSelect }: Props) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "id", desc: false }])

  // Augment each model once with derived caps + joined telemetry (accessorFns read this).
  const data = useMemo<Array<Row>>(
    () => models.map((m) => ({ model: m, caps: deriveCapabilities(m), req: telemetryFor(m.id)?.last7d?.requestCount ?? 0 })),
    [models, telemetryFor],
  )

  const columns = useMemo(
    () => [
      col.accessor((r) => r.model.id, {
        id: "id",
        header: "Model",
        enableHiding: false,
        cell: (c) => (
          <span className="text-[var(--color-primary)]">
            {onSelect ?
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect(c.row.original.model.id)
                }}
                aria-label={`Open details for ${c.row.original.model.id}`}
                className="text-left text-[var(--color-primary)] hover:underline"
              >
                {c.getValue<string>()}
              </button>
            : c.getValue<string>()}
          </span>
        ),
      }),
      col.accessor((r) => r.model.vendor, { id: "vendor", header: "Vendor", cell: (c) => <span className="text-[#aaa]">{c.getValue<string>()}</span> }),
      col.accessor((r) => r.caps.contextWindow ?? 0, {
        id: "context",
        header: "Ctx",
        cell: (c) => <span className="text-[#cdb]">{formatNumber(c.getValue<number>())}</span>,
      }),
      col.accessor((r) => r.caps.maxOutput ?? 0, {
        id: "output",
        header: "Out",
        cell: (c) => <span className="text-[#cdb]">{formatNumber(c.getValue<number>())}</span>,
      }),
      col.accessor((r) => r.caps.reasoningEffort.join("/"), {
        id: "effort",
        header: "Effort",
        cell: (c) => <span className="text-[var(--color-muted)]">{c.getValue<string>() || "-"}</span>,
      }),
      ...CAPS.map((cap) =>
        col.accessor((r) => Boolean(r.caps[cap.key]), {
          id: cap.id,
          header: cap.label,
          cell: (c) => (c.getValue<boolean>() ? <span className="text-[var(--color-ok)]">✓</span> : <span className="text-[#3a3a42]">·</span>),
        }),
      ),
      col.accessor((r) => r.model.billing?.multiplier ?? 0, {
        id: "billing",
        header: "$×",
        cell: (c) => <span className="text-[#cdb]">{c.getValue<number>() || "-"}</span>,
      }),
      col.accessor((r) => r.req, {
        id: "requests7d",
        header: "Req 7d",
        cell: (c) => {
          const req = c.getValue<number>()
          return (
            <span className="relative text-[#cdb]">
              {req || "-"}
              {req > 0 ?
                <span
                  className="absolute bottom-0 left-0 h-[2px] bg-[var(--color-primary)] opacity-60"
                  style={{ width: `${maxRequests7d > 0 ? (req / maxRequests7d) * 100 : 0}%` }}
                />
              : null}
            </span>
          )
        },
      }),
    ],
    [onSelect, maxRequests7d],
  )

  const table = useReactTable({
    data,
    columns,
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <table className="mono w-full text-[12px]">
      <thead className="sticky top-0 z-[1] bg-[var(--color-bg)]">
        {table.getHeaderGroups().map((hg) => (
          <tr key={hg.id}>
            {hg.headers.map((h) => {
              const sorted = h.column.getIsSorted()
              return (
                <th
                  key={h.id}
                  scope="col"
                  aria-sort={ariaSortAttr(sorted)}
                  className={HEAD}
                >
                  <button
                    type="button"
                    onClick={h.column.getToggleSortingHandler()}
                    className="mono cursor-pointer select-none border-0 bg-transparent p-0 uppercase tracking-wider text-inherit hover:text-[var(--color-primary)]"
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {sortArrow(sorted)}
                  </button>
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
                  className="px-2 py-1"
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
