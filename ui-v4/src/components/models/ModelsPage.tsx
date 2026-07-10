import type { SortingState } from "@tanstack/react-table"

import { getEffectiveEndpoints } from "~backend/lib/models/endpoint"
import {
  //
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"
import { useSearchParams } from "react-router-dom"

import { RawJsonView } from "@/components/common/RawJsonView"
import { ModelDetail } from "@/components/models/ModelDetail"
import { ModelsColumnMenu } from "@/components/models/ModelsColumnMenu"
import { ModelsFilterBar } from "@/components/models/ModelsFilterBar"
import { ModelsTable } from "@/components/models/ModelsTable"
import { UnmatchedTelemetry } from "@/components/models/UnmatchedTelemetry"
import { useModels } from "@/hooks/useModels"
import { useModelTelemetry } from "@/hooks/useModelTelemetry"
import {
  //
  DEFAULT_COLUMN_VISIBILITY,
  mergeColumnVisibility,
  type ModelColumnKey,
  type ModelColumnVisibility,
} from "@/lib/model-columns"
import {
  //
  EMPTY_FILTERS,
  filterModels,
  modelBillingBounds,
  type ModelFilters,
} from "@/lib/model-filters"
import { modelStatus } from "@/lib/model-status"
import {
  //
  buildModelTelemetryIndex,
  telemetryForId,
} from "@/lib/model-telemetry"

const COLUMNS_KEY = "copilot-api-ui-v4-models-columns"

function loadColumns(): ModelColumnVisibility {
  try {
    return mergeColumnVisibility(JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? "null") as Partial<ModelColumnVisibility> | null)
  } catch {
    return { ...DEFAULT_COLUMN_VISIBILITY }
  }
}

export function ModelsPage() {
  const { data, isLoading, isError, error } = useModels()
  const { data: telemetry } = useModelTelemetry()
  const [searchParams, setSearchParams] = useSearchParams()
  const [raw, setRaw] = useState(false)
  const [columns, setColumns] = useState<ModelColumnVisibility>(loadColumns)
  const [filters, setFilters] = useState<ModelFilters>(EMPTY_FILTERS)
  // Sort state is lifted here (controlled) and passed to ModelsTable; TanStack owns
  // the actual sort inside the table.
  const [sorting, setSorting] = useState<SortingState>([{ id: "id", desc: false }])

  useEffect(() => {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify(columns))
  }, [columns])

  const models = useMemo(() => data?.data ?? [], [data])

  // Config-disabled ids from the envelope; useMemo so the Set identity is stable
  // (feeds statusFor → columns/filter; an unstable Set rebuilds the row model).
  const configDisabledSet = useMemo(() => new Set(data?.disabled ?? []), [data])
  const statusFor = useMemo(() => (m: (typeof models)[number]) => modelStatus(m, configDisabledSet), [configDisabledSet])

  const index = useMemo(() => buildModelTelemetryIndex(telemetry ?? null, models), [telemetry, models])
  const telemetryFor = useMemo(() => (id: string) => telemetryForId(index, id), [index])
  const hasTelemetry = useMemo(() => (id: string) => telemetryForId(index, id) !== null, [index])
  const maxRequests7d = useMemo(() => {
    let max = 1
    for (const j of index.byId.values()) max = Math.max(max, j.last7d?.requestCount ?? 0)
    return max
  }, [index])

  // Selection is URL-borne (`?model=<id>`, URL-as-truth): resolve against the FULL
  // catalog (not the filtered view) so a shared/deep link opens even when the model
  // is filtered out of the current table.
  const selectedId = searchParams.get("model")
  const selectedModel = useMemo(() => (selectedId ? (models.find((m) => m.id === selectedId) ?? null) : null), [models, selectedId])
  // `select` is passed as ModelsTable's `onSelect`, which feeds the memoized column
  // builder — keep its identity stable (useCallback) so the columns/row-model aren't
  // rebuilt on every ModelsPage render (filters/sorting/selection all re-render this).
  const select = useCallback(
    (id: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set("model", id)
        return next
      })
    },
    [setSearchParams],
  )
  const clearSelection = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete("model")
        return next
      },
      { replace: true },
    )
  }, [setSearchParams])

  const options = useMemo(
    () => ({
      vendors: [...new Set(models.map((m) => m.vendor).filter(Boolean))].sort(),
      types: [...new Set(models.map((m) => m.capabilities?.type).filter((v): v is string => typeof v === "string" && v.length > 0))].sort(),
      endpoints: [...new Set(models.flatMap((m) => getEffectiveEndpoints(m) ?? []))].sort(),
      restrictedTo: [...new Set(models.flatMap((m) => m.billing?.restricted_to ?? []))].sort(),
      policyStates: [...new Set(models.map((m) => m.policy?.state).filter((v): v is string => typeof v === "string" && v.length > 0))].sort(),
    }),
    [models],
  )

  // Filter only — TanStack owns sorting inside the table (state lifted above as
  // controlled state passed to ModelsTable).
  const visible = useMemo(() => filterModels(models, filters, hasTelemetry, statusFor), [models, filters, hasTelemetry, statusFor])
  const billingBounds = useMemo(() => modelBillingBounds(models), [models])

  const onChange = (patch: Partial<ModelFilters>) => setFilters((f) => ({ ...f, ...patch }))
  const toggleColumn = (key: ModelColumnKey) => setColumns((c) => ({ ...c, [key]: !c[key] }))
  const resetColumns = () => setColumns({ ...DEFAULT_COLUMN_VISIBILITY })

  if (isLoading) return <div className="mono p-4 text-[#888]">loading…</div>
  // A query failure is distinct from an empty result — render a dedicated error
  // branch instead of falling through to the "No models match…" empty state, which
  // would disguise a load failure as an (incorrectly) empty catalog.
  if (isError)
    return (
      <div className="mono flex flex-col gap-1 p-4 text-[var(--color-fail)]">
        <div>⚠ failed to load models</div>
        <div className="text-[12px] text-[var(--color-muted)]">{error instanceof Error ? error.message : String(error)}</div>
      </div>
    )

  return (
    <div className="mono flex min-h-0 flex-1 flex-col text-[13px]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-1">
        <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">
          Models · {visible.length}/{models.length} · {options.vendors.length} vendors · {options.endpoints.length} endpoints
        </div>
        <div className="ml-auto flex items-center gap-2">
          <ModelsColumnMenu
            columns={columns}
            onToggle={toggleColumn}
            onReset={resetColumns}
          />
          <button
            type="button"
            className="text-[12px] text-[var(--color-primary)]"
            onClick={() => setRaw((v) => !v)}
          >
            {raw ? "table" : "raw JSON"}
          </button>
        </div>
      </div>

      {raw ?
        // Feed the FULL response envelope (`{ data: [...] }`), not the bare models
        // array — restores parity with the Vue list AND gives the dual source/tree view.
        <RawJsonView value={data ?? { data: [] }} />
      : <>
          <ModelsFilterBar
            filters={filters}
            onChange={onChange}
            options={options}
            billingBounds={billingBounds}
          />
          <div className="min-h-0 flex-1 overflow-auto">
            {visible.length === 0 ?
              <div className="p-4 text-[#888]">
                {models.length === 0 ?
                  "No models in the catalog."
                : <>
                    No models match the current filters.
                    <div className="mt-1 text-[12px] text-[var(--color-muted)]">Try relaxing your search or clearing a filter.</div>
                  </>
                }
              </div>
            : <ModelsTable
                models={visible}
                columnVisibility={columns}
                telemetryFor={telemetryFor}
                statusFor={statusFor}
                maxRequests7d={maxRequests7d}
                sorting={sorting}
                onSortingChange={setSorting}
                selectedId={selectedId}
                onSelect={select}
              />
            }
            <UnmatchedTelemetry rows={index.unmatched} />
          </div>
          {/* Modal drawer (Radix Dialog portal) — overlays the full-width table
              above rather than sharing a flex row that would squeeze it. */}
          {selectedModel ?
            <ModelDetail
              key={selectedModel.id}
              model={selectedModel}
              telemetry={telemetryFor(selectedModel.id)}
              status={statusFor(selectedModel)}
              onClose={clearSelection}
            />
          : null}
        </>
      }
    </div>
  )
}
