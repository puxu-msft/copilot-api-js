import type {
  //
  ColumnDef,
  Row,
  RowData,
} from "@tanstack/react-table"
import type { DerivedCapabilities } from "~backend/lib/models/capabilities"
import type { Model } from "~backend/lib/models/client"

import { createColumnHelper } from "@tanstack/react-table"
import { deriveCapabilities } from "~backend/lib/models/capabilities"

import type { ModelColumnKey } from "@/lib/model-columns"
import type { ModelStatus } from "@/lib/model-status"
import type { JoinedModelTelemetry } from "@/lib/model-telemetry"

import { formatNumber } from "@/lib/format"
import { statusMeta } from "@/lib/model-status"
import { thinkingLabel } from "@/lib/model-thinking"
import { vendorColor } from "@/lib/vendor-color"

/**
 * Shared column definition for the Models table (headless-component-stack ADR:
 * data table = TanStack Table). This is the SINGLE source of column identity,
 * accessors, sort semantics, and Terminal Amber cell rendering.
 *
 * `ModelsTable` turns {@link buildModelColumns} into a `useReactTable` instance
 * (TanStack owns sorting + `columnVisibility`), reading the shared {@link ACCESSORS}
 * + {@link compareValues} so there is one place a sortable value is derived.
 */

export interface ModelRow {
  model: Model
  /** Derived once per model (not per cell) so accessors/cells read a stable object. */
  caps: DerivedCapabilities
  /** Joined telemetry requests(7d), 0 when unmatched — pre-resolved for accessor + mini-bar. */
  req: number
  /** UI status (config/picker-disabled/enabled), pre-resolved once per row. */
  status: ModelStatus
}

/** Attach derived capabilities + joined telemetry + UI status to each model, once. */
export function augmentRows(
  models: Array<Model>,
  telemetryFor: (id: string) => JoinedModelTelemetry | null,
  statusFor: (model: Model) => ModelStatus,
): Array<ModelRow> {
  return models.map((model) => ({
    model,
    caps: deriveCapabilities(model),
    req: telemetryFor(model.id)?.last7d?.requestCount ?? 0,
    status: statusFor(model),
  }))
}

/** Per-column head/cell Terminal Amber classes, carried on the ColumnDef so both
 *  the `<th>` and `<td>` render identical alignment/colour to the hand-written table. */
declare module "@tanstack/react-table" {
  // TData/TValue are unused here but MUST mirror the library's ColumnMeta signature
  // (TS2428: augmentation type parameters must be identical to the original).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    thClass?: string
    tdClass?: string
  }
}

type SortableColumnId = "id" | "vendor" | "context" | "output" | "billing" | "requests7d"
type SortableValue = string | number

/**
 * Single accessor source for the sortable columns. The ColumnDef `accessorFn`
 * reads these — the ONLY place a sortable value is derived.
 */
const ACCESSORS = {
  id: (r) => r.model.id,
  vendor: (r) => r.model.vendor,
  context: (r) => r.caps.contextWindow ?? 0,
  output: (r) => r.caps.maxOutput ?? 0,
  billing: (r) => r.model.billing?.multiplier ?? 0,
  requests7d: (r) => r.req,
} satisfies Record<SortableColumnId, (row: ModelRow) => SortableValue>

/** Numeric columns sort DESC on first click (TanStack's smart default, preserved). */
const NUMERIC_COLUMNS: ReadonlySet<SortableColumnId> = new Set(["context", "output", "billing", "requests7d"])

/**
 * Shared comparator (ascending). Numbers subtract; anything else compares as a
 * locale string. Used as the columns' `sortingFn`.
 */
function compareValues(a: SortableValue, b: SortableValue): number {
  return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))
}

/** TanStack `sortingFn`: read the (shared) accessor value off each row and compare. */
function sharedSortingFn(a: Row<ModelRow>, b: Row<ModelRow>, columnId: string): number {
  return compareValues(a.getValue<SortableValue>(columnId), b.getValue<SortableValue>(columnId))
}

/** WAI-ARIA `aria-sort` from TanStack `getIsSorted()`. */
export function ariaSortAttr(sorted: false | "asc" | "desc"): "ascending" | "descending" | "none" {
  if (sorted === "asc") return "ascending"
  if (sorted === "desc") return "descending"
  return "none"
}

/** Header caret from TanStack `getIsSorted()`. */
export function sortCaret(sorted: false | "asc" | "desc"): string {
  if (sorted === "asc") return " ▲"
  if (sorted === "desc") return " ▼"
  return ""
}

const HEAD = "px-2 py-1 text-left text-[11px] uppercase tracking-wider text-[var(--content-muted)]"

/** Capability matrix columns: derived boolean, centred, non-sortable ✓/· cells. */
const CAP_COLS: ReadonlyArray<{ key: ModelColumnKey; deriveKey: keyof DerivedCapabilities; label: string }> = [
  { key: "vision", deriveKey: "vision", label: "Vis" },
  { key: "toolCalls", deriveKey: "toolCalls", label: "Tool" },
  { key: "parallelToolCalls", deriveKey: "parallelToolCalls", label: "Par" },
  { key: "structuredOutputs", deriveKey: "structuredOutputs", label: "Struct" },
  { key: "streaming", deriveKey: "streaming", label: "Strm" },
]

const col = createColumnHelper<ModelRow>()

export interface BuildColumnsOptions {
  maxRequests7d: number
  onSelect?: (id: string) => void
}

/**
 * Build the TanStack column definitions. Column `id`s are `ModelColumnKey` (so the
 * column menu's `VisibilityState` keys line up) plus the always-shown `"id"` column.
 * Sortable columns carry {@link sharedSortingFn}; derived (effort/caps) columns are
 * non-sortable, matching the hand-written table's exact sortable set + visuals.
 */
export function buildModelColumns({ maxRequests7d, onSelect }: BuildColumnsOptions): Array<ColumnDef<ModelRow>> {
  const sortable = (id: SortableColumnId, header: string, tdClass: string, extraHead = "") =>
    col.accessor(ACCESSORS[id], {
      id,
      header,
      enableHiding: id !== "id",
      sortingFn: sharedSortingFn,
      sortDescFirst: NUMERIC_COLUMNS.has(id),
      meta: { thClass: extraHead ? `${HEAD} ${extraHead}` : HEAD, tdClass },
    })

  return [
    col.accessor(ACCESSORS.id, {
      id: "id",
      header: "Model",
      enableHiding: false,
      sortingFn: sharedSortingFn,
      sortDescFirst: false,
      meta: { thClass: HEAD, tdClass: "px-2 py-1" },
      cell: (c) => {
        const m = c.row.original.model
        return (
          <>
            {onSelect ?
              <button
                type="button"
                // Stop propagation so keyboard/AT activation on the id doesn't also
                // fire the row's mouse onClick (harmless, but avoids a double select).
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect(m.id)
                }}
                aria-label={`Open details for ${m.id}`}
                className="text-left text-[var(--content-accent)] hover:underline"
              >
                {m.id}
              </button>
            : <span className="text-[var(--content-accent)]">{m.id}</span>}
            {m.is_chat_default ?
              <span className="ml-1 text-[10px] text-[var(--content-muted)]">default</span>
            : null}
            {m.preview ?
              <span className="ml-1 text-[10px] text-[var(--content-muted)]">preview</span>
            : null}
          </>
        )
      },
    }),
    col.accessor((r) => r.status, {
      id: "status",
      header: "Status",
      enableSorting: false,
      meta: { thClass: HEAD, tdClass: "px-2 py-1" },
      cell: (c) => {
        // Dot-based status (SSOT vocabulary in `statusMeta`): enabled is a quiet
        // muted dot only (majority default → no per-row text noise); the two
        // disabled kinds add a short label + a shape cue (● vs ○). `role="img"` +
        // `aria-label` give the full reason a real accessible name (a bare span's
        // aria-label is dropped by AT); the label text stays `--color-text` for
        // readable contrast (the muted/red color rides on the dot, which is
        // non-text UI at the lower 3:1 bar).
        const m = statusMeta(c.getValue<ModelStatus>())
        return (
          <span
            role="img"
            aria-label={m.title}
            title={m.title}
            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-[var(--content-text)]"
          >
            <span
              aria-hidden="true"
              style={{ color: m.colorVar }}
            >
              {m.glyph}
            </span>
            {m.label}
          </span>
        )
      },
    }),
    {
      ...sortable("vendor", "Vendor", "px-2 py-1 text-[var(--content-secondary)]"),
      cell: (c) => {
        const v = c.row.original.model.vendor
        const color = vendorColor(v)
        return (
          <span
            className="border px-1.5 py-0.5 text-[11px]"
            style={{ color, borderColor: color }}
          >
            {v || "—"}
          </span>
        )
      },
    },
    {
      ...sortable("context", "Ctx", "px-2 py-1 text-right text-[var(--content-value)]", "text-right"),
      cell: (c) => formatNumber(c.row.original.caps.contextWindow),
    },
    {
      ...sortable("output", "Out", "px-2 py-1 text-right text-[var(--content-value)]", "text-right"),
      cell: (c) => formatNumber(c.row.original.caps.maxOutput),
    },
    col.accessor((r) => r.caps.reasoningEffort.join("/"), {
      id: "effort",
      header: "Effort",
      enableSorting: false,
      meta: { thClass: `${HEAD} text-right`, tdClass: "px-2 py-1 text-right text-[var(--content-muted)]" },
      cell: (c) => c.getValue<string>() || "-",
    }),
    ...CAP_COLS.map((cap) =>
      col.accessor((r) => r.caps[cap.deriveKey], {
        id: cap.key,
        header: cap.label,
        enableSorting: false,
        meta: { thClass: `${HEAD} text-center`, tdClass: "px-2 py-1 text-center" },
        cell: (c) => (c.getValue<boolean>() ? <span className="text-[var(--signal-ok)]">✓</span> : <span className="text-[var(--content-off)]">·</span>),
      }),
    ),
    // Thinking stays the last capability column (id `"thinking"` keeps the column
    // menu + its localStorage visibility key aligned) but renders a dedicated cell
    // showing the actual budget (adaptive / ≤N) instead of an opaque ✓.
    col.accessor((r) => r.caps.thinking, {
      id: "thinking",
      header: "Think",
      enableSorting: false,
      meta: { thClass: `${HEAD} text-center`, tdClass: "px-2 py-1 text-center text-[11px]" },
      cell: (c) => {
        const { text, title } = thinkingLabel(c.row.original.caps)
        const on = text !== "·"
        return (
          <span
            title={title}
            className={on ? "text-[var(--signal-ok)]" : "text-[var(--content-off)]"}
          >
            {text}
          </span>
        )
      },
    }),
    {
      ...sortable("billing", "$×", "px-2 py-1 text-right text-[var(--content-value)]", "text-right"),
      cell: (c) => c.row.original.model.billing?.multiplier ?? "-",
    },
    {
      ...sortable("requests7d", "Req 7d", "relative px-2 py-1 text-right text-[var(--content-value)]", "text-right"),
      cell: (c) => {
        const req = c.row.original.req
        return (
          <>
            {req || "-"}
            {req > 0 ?
              <span
                className="absolute bottom-0 left-0 h-[2px] bg-[var(--content-accent)] opacity-60"
                style={{ width: `${maxRequests7d > 0 ? (req / maxRequests7d) * 100 : 0}%` }}
              />
            : null}
          </>
        )
      },
    },
  ] as Array<ColumnDef<ModelRow>>
}
