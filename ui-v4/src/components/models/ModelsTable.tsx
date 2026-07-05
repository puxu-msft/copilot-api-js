import type { DerivedCapabilities } from "~backend/lib/models/capabilities"
import type { Model } from "~backend/lib/models/client"

import { deriveCapabilities } from "~backend/lib/models/capabilities"
import { useMemo } from "react"

import type {
  //
  ModelColumnKey,
  ModelColumnVisibility,
} from "@/lib/model-columns"
import type { ModelSortKey } from "@/lib/model-filters"
import type { JoinedModelTelemetry } from "@/lib/model-telemetry"

import { formatNumber } from "@/lib/format"

const CAP_COLS: ReadonlyArray<{ key: ModelColumnKey; deriveKey: keyof DerivedCapabilities; label: string }> = [
  { key: "vision", deriveKey: "vision", label: "Vis" },
  { key: "toolCalls", deriveKey: "toolCalls", label: "Tool" },
  { key: "parallelToolCalls", deriveKey: "parallelToolCalls", label: "Par" },
  { key: "structuredOutputs", deriveKey: "structuredOutputs", label: "Struct" },
  { key: "streaming", deriveKey: "streaming", label: "Strm" },
  { key: "thinking", deriveKey: "thinking", label: "Think" },
]

interface ModelsTableProps {
  models: Array<Model>
  columns: ModelColumnVisibility
  telemetryFor: (id: string) => JoinedModelTelemetry | null
  maxRequests7d: number
  sortKey: ModelSortKey
  sortDesc: boolean
  onSort: (key: ModelSortKey) => void
  selectedId?: string | null
  onSelect?: (id: string) => void
}

const HEAD = "px-2 py-1 text-left text-[11px] uppercase tracking-wider text-[var(--color-muted)]"

export function ModelsTable({ models, columns, telemetryFor, maxRequests7d, sortKey, sortDesc, onSort, selectedId, onSelect }: ModelsTableProps) {
  const capsById = useMemo(() => {
    const map = new Map<string, DerivedCapabilities>()
    for (const m of models) map.set(m.id, deriveCapabilities(m))
    return map
  }, [models])

  const caret = (key: ModelSortKey) => {
    if (sortKey !== key) return ""
    return sortDesc ? " ▼" : " ▲"
  }
  const sortable = (key: ModelSortKey, label: string, extra = "") => (
    <th
      className={`${HEAD} cursor-pointer select-none hover:text-[var(--color-primary)] ${extra}`}
      onClick={() => onSort(key)}
    >
      {label}
      {caret(key)}
    </th>
  )

  return (
    <table className="mono w-full text-[12px]">
      <thead className="sticky top-0 z-[1] bg-[var(--color-bg)]">
        <tr>
          {sortable("id", "Model")}
          {columns.vendor ? sortable("vendor", "Vendor") : null}
          {columns.context ? sortable("context", "Ctx", "text-right") : null}
          {columns.output ? sortable("output", "Out", "text-right") : null}
          {columns.effort ?
            <th className={`${HEAD} text-right`}>Effort</th>
          : null}
          {CAP_COLS.map((c) =>
            columns[c.key] ?
              <th
                key={c.key}
                className={`${HEAD} text-center`}
              >
                {c.label}
              </th>
            : null,
          )}
          {columns.billing ? sortable("billing", "$×", "text-right") : null}
          {columns.requests7d ? sortable("requests7d", "Req 7d", "text-right") : null}
        </tr>
      </thead>
      <tbody>
        {models.map((m) => {
          const caps = capsById.get(m.id) ?? deriveCapabilities(m)
          const req = telemetryFor(m.id)?.last7d?.requestCount ?? 0
          const selected = m.id === selectedId
          return (
            <tr
              key={m.id}
              className={`border-b border-[#1e1e24] ${onSelect ? "cursor-pointer hover:bg-[#1a1a20]" : ""} ${selected ? "border-l-2 border-l-[var(--color-primary)] bg-[#3a2f1a]" : ""}`}
              aria-selected={selected}
              onClick={onSelect ? () => onSelect(m.id) : undefined}
            >
              <td className="px-2 py-1 text-[var(--color-primary)]">
                {m.id}
                {m.is_chat_default ?
                  <span className="ml-1 text-[10px] text-[var(--color-muted)]">default</span>
                : null}
                {m.preview ?
                  <span className="ml-1 text-[10px] text-[var(--color-muted)]">preview</span>
                : null}
              </td>
              {columns.vendor ?
                <td className="px-2 py-1 text-[#aaa]">{m.vendor}</td>
              : null}
              {columns.context ?
                <td className="px-2 py-1 text-right text-[#cdb]">{formatNumber(caps.contextWindow)}</td>
              : null}
              {columns.output ?
                <td className="px-2 py-1 text-right text-[#cdb]">{formatNumber(caps.maxOutput)}</td>
              : null}
              {columns.effort ?
                <td className="px-2 py-1 text-right text-[var(--color-muted)]">{caps.reasoningEffort.join("/") || "-"}</td>
              : null}
              {CAP_COLS.map((c) =>
                columns[c.key] ?
                  <td
                    key={c.key}
                    className="px-2 py-1 text-center"
                  >
                    {caps[c.deriveKey] ?
                      <span className="text-[var(--color-ok)]">✓</span>
                    : <span className="text-[#3a3a42]">·</span>}
                  </td>
                : null,
              )}
              {columns.billing ?
                <td className="px-2 py-1 text-right text-[#cdb]">{m.billing?.multiplier ?? "-"}</td>
              : null}
              {columns.requests7d ?
                <td className="relative px-2 py-1 text-right text-[#cdb]">
                  {req || "-"}
                  {req > 0 ?
                    <span
                      className="absolute bottom-0 left-0 h-[2px] bg-[var(--color-primary)] opacity-60"
                      style={{ width: `${maxRequests7d > 0 ? (req / maxRequests7d) * 100 : 0}%` }}
                    />
                  : null}
                </td>
              : null}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
