import type { DerivedCapabilities } from "~backend/lib/models/capabilities"
import type { Model } from "~backend/lib/models/client"

import { deriveCapabilities } from "~backend/lib/models/capabilities"
import {
  //
  useMemo,
  useState,
} from "react"
import {
  //
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
  type SortDescriptor,
} from "react-aria-components"

import type { JoinedModelTelemetry } from "@/lib/model-telemetry"

import { formatNumber } from "@/lib/format"

/**
 * PoC (headless-component-stack ADR): a **react-aria** rebuild of ModelsTable,
 * same interface/capabilities as the TanStack PoC — for a same-yardstick compare.
 *
 * What it shows vs TanStack Table:
 * - **a11y is white-sent**: react-aria `Table` renders a real grid with full
 *   keyboard grid navigation, `aria-sort` on sortable columns, and row-action
 *   keyboard activation (Enter) via `onRowAction` — NONE of which we hand-write
 *   (the TanStack PoC hand-wrote `ariaSortAttr`/`sortArrow` + an id `<button>`).
 * - **but the DATA LOGIC is ours**: react-aria gives `sortDescriptor` +
 *   `onSortChange` (the interaction), but the actual sort COMPARATOR is
 *   hand-written below — react-aria has no getSortedRowModel, no column
 *   visibility state, no faceting/grouping. That is TanStack's domain.
 * - **column visibility is hand-rolled**: no `VisibilityState` — we filter the
 *   column list ourselves (TanStack has it built-in).
 * - **visuals self-controlled** (Terminal Amber via className + data-attrs).
 */

interface Row2 {
  model: Model
  caps: DerivedCapabilities
  req: number
}

interface ColDef {
  id: string
  label: string
  isRowHeader?: boolean
  accessor: (r: Row2) => string | number
}

const COLUMNS: ReadonlyArray<ColDef> = [
  { id: "id", label: "Model", isRowHeader: true, accessor: (r) => r.model.id },
  { id: "vendor", label: "Vendor", accessor: (r) => r.model.vendor },
  { id: "context", label: "Ctx", accessor: (r) => r.caps.contextWindow ?? 0 },
  { id: "output", label: "Out", accessor: (r) => r.caps.maxOutput ?? 0 },
  { id: "vision", label: "Vis", accessor: (r) => Number(r.caps.vision) },
  { id: "toolCalls", label: "Tool", accessor: (r) => Number(r.caps.toolCalls) },
  { id: "thinking", label: "Think", accessor: (r) => Number(r.caps.thinking) },
  { id: "billing", label: "$×", accessor: (r) => r.model.billing?.multiplier ?? 0 },
  { id: "requests7d", label: "Req 7d", accessor: (r) => r.req },
]

const HEAD = "px-2 py-1 text-left text-[11px] uppercase tracking-wider text-[var(--color-muted)]"

/** Terminal Amber cell content per column id (self-rendered — react-aria is headless). */
function renderCell(row: Row2, colId: string): React.ReactNode {
  switch (colId) {
    case "id": {
      return <span className="text-[var(--color-primary)]">{row.model.id}</span>
    }
    case "vendor": {
      return <span className="text-[#aaa]">{row.model.vendor}</span>
    }
    case "context": {
      return <span className="text-[#cdb]">{formatNumber(row.caps.contextWindow)}</span>
    }
    case "output": {
      return <span className="text-[#cdb]">{formatNumber(row.caps.maxOutput)}</span>
    }
    case "vision":
    case "toolCalls":
    case "thinking": {
      return row.caps[colId as keyof DerivedCapabilities] ? <span className="text-[var(--color-ok)]">✓</span> : <span className="text-[#3a3a42]">·</span>
    }
    case "billing": {
      return <span className="text-[#cdb]">{row.model.billing?.multiplier ?? "-"}</span>
    }
    case "requests7d": {
      return <span className="text-[#cdb]">{row.req || "-"}</span>
    }
    default: {
      return null
    }
  }
}

interface Props {
  models: Array<Model>
  telemetryFor: (id: string) => JoinedModelTelemetry | null
  /** A column is visible unless explicitly `false` (missing key = visible). */
  columnVisibility: Record<string, boolean | undefined>
  selectedId?: string | null
  onSelect?: (id: string) => void
}

export function ModelsTableAria({ models, telemetryFor, columnVisibility, selectedId, onSelect }: Props) {
  const [sort, setSort] = useState<SortDescriptor>({ column: "id", direction: "ascending" })

  const data = useMemo<Array<Row2>>(
    () => models.map((m) => ({ model: m, caps: deriveCapabilities(m), req: telemetryFor(m.id)?.last7d?.requestCount ?? 0 })),
    [models, telemetryFor],
  )

  // Column visibility: HAND-ROLLED (react-aria has no VisibilityState). id always shown;
  // a column is visible unless explicitly false.
  const visibleColumns = useMemo(() => COLUMNS.filter((c) => c.id === "id" || columnVisibility[c.id] !== false), [columnVisibility])

  // Sort COMPARATOR: HAND-WRITTEN (react-aria gives the interaction, not the algorithm).
  const sortedData = useMemo(() => {
    const c = COLUMNS.find((x) => x.id === sort.column)
    if (!c) return data
    const arr = [...data].sort((a, b) => {
      const va = c.accessor(a)
      const vb = c.accessor(b)
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb))
      return sort.direction === "descending" ? -cmp : cmp
    })
    return arr
  }, [data, sort])

  return (
    <Table
      aria-label="Models (react-aria PoC)"
      sortDescriptor={sort}
      onSortChange={setSort}
      onRowAction={onSelect ? (key) => onSelect(String(key)) : undefined}
      className="mono w-full text-[12px]"
    >
      <TableHeader columns={visibleColumns}>
        {(c) => (
          <Column
            id={c.id}
            isRowHeader={c.isRowHeader}
            allowsSorting
            className={HEAD}
          >
            {c.label}
          </Column>
        )}
      </TableHeader>
      <TableBody items={sortedData}>
        {(row) => (
          <Row
            id={row.model.id}
            columns={visibleColumns}
            className={`border-b border-[#1e1e24] ${onSelect ? "cursor-pointer" : ""} ${row.model.id === selectedId ? "border-l-2 border-l-[var(--color-primary)] bg-[#3a2f1a]" : ""}`}
          >
            {(c) => <Cell className="px-2 py-1">{renderCell(row, c.id)}</Cell>}
          </Row>
        )}
      </TableBody>
    </Table>
  )
}
