import {
  //
  useEffect,
  useMemo,
  useState,
} from "react"
import { useSearchParams } from "react-router-dom"

import { ModelDetail } from "@/components/models/ModelDetail"
import { ModelsColumnMenu } from "@/components/models/ModelsColumnMenu"
import { ModelsFilterBar } from "@/components/models/ModelsFilterBar"
import { ModelsTable } from "@/components/models/ModelsTable"
import { UnmatchedTelemetry } from "@/components/models/UnmatchedTelemetry"
import { useModels } from "@/hooks/useModels"
import { useModelTelemetry } from "@/hooks/useModelTelemetry"
import { triggerDownload } from "@/lib/export-entry"
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
  sortModels,
  type ModelFilters,
  type ModelSortKey,
} from "@/lib/model-filters"
import {
  //
  buildModelTelemetryIndex,
  telemetryForId,
} from "@/lib/model-telemetry"
import { modelsToCsv } from "@/lib/models-csv"

const COLUMNS_KEY = "copilot-api-ui-v4-models-columns"

function loadColumns(): ModelColumnVisibility {
  try {
    return mergeColumnVisibility(JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? "null") as Partial<ModelColumnVisibility> | null)
  } catch {
    return { ...DEFAULT_COLUMN_VISIBILITY }
  }
}

export function ModelsPage() {
  const { data, isLoading } = useModels()
  const { data: telemetry } = useModelTelemetry()
  const [searchParams, setSearchParams] = useSearchParams()
  const [raw, setRaw] = useState(false)
  const [columns, setColumns] = useState<ModelColumnVisibility>(loadColumns)
  const [filters, setFilters] = useState<ModelFilters>(EMPTY_FILTERS)
  const [sort, setSort] = useState<{ key: ModelSortKey; desc: boolean }>({ key: "id", desc: false })

  useEffect(() => {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify(columns))
  }, [columns])

  const models = useMemo(() => data?.data ?? [], [data])

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
  const select = (id: string) => {
    const next = new URLSearchParams(searchParams)
    next.set("model", id)
    setSearchParams(next)
  }
  const clearSelection = () => {
    const next = new URLSearchParams(searchParams)
    next.delete("model")
    setSearchParams(next, { replace: true })
  }

  const options = useMemo(
    () => ({
      vendors: [...new Set(models.map((m) => m.vendor).filter(Boolean))].sort(),
      types: [...new Set(models.map((m) => m.capabilities?.type).filter((v): v is string => typeof v === "string" && v.length > 0))].sort(),
      restrictedTo: [...new Set(models.flatMap((m) => m.billing?.restricted_to ?? []))].sort(),
      policyStates: [...new Set(models.map((m) => m.policy?.state).filter((v): v is string => typeof v === "string" && v.length > 0))].sort(),
    }),
    [models],
  )

  const visible = useMemo(() => {
    const filtered = filterModels(models, filters, hasTelemetry)
    return sortModels(filtered, sort.key, sort.desc, (id) => telemetryFor(id)?.last7d?.requestCount ?? 0)
  }, [models, filters, hasTelemetry, sort, telemetryFor])

  const onChange = (patch: Partial<ModelFilters>) => setFilters((f) => ({ ...f, ...patch }))
  const onSort = (key: ModelSortKey) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key === "context" || key === "output" || key === "billing" || key === "requests7d" }))
  const toggleColumn = (key: ModelColumnKey) => setColumns((c) => ({ ...c, [key]: !c[key] }))
  const resetColumns = () => setColumns({ ...DEFAULT_COLUMN_VISIBILITY })

  // Export the CURRENT filtered/sorted view (spec §7); telemetry columns use the
  // same normalized join as the table.
  const exportCsv = () => {
    const csv = modelsToCsv(visible, telemetryFor)
    triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8" }), "models.csv")
  }

  if (isLoading) return <div className="mono p-4 text-[#888]">loading…</div>

  return (
    <div className="mono flex min-h-0 flex-1 flex-col text-[13px]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-1">
        <div className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">
          Models · {visible.length}/{models.length}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <ModelsColumnMenu
            columns={columns}
            onToggle={toggleColumn}
            onReset={resetColumns}
          />
          <button
            type="button"
            className="mono border border-[var(--color-border)] px-2 py-1 text-[12px] text-[var(--color-text)] hover:text-[var(--color-primary)]"
            onClick={exportCsv}
          >
            Export CSV
          </button>
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
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-2 text-[12px] text-[#aaa]">{JSON.stringify(models, null, 2)}</pre>
      : <>
          <ModelsFilterBar
            filters={filters}
            onChange={onChange}
            options={options}
          />
          <div className="flex min-h-0 flex-1">
            <div className="min-h-0 flex-1 overflow-auto">
              {visible.length === 0 ?
                <div className="p-4 text-[#888]">No models match the current filters.</div>
              : <ModelsTable
                  models={visible}
                  columns={columns}
                  telemetryFor={telemetryFor}
                  maxRequests7d={maxRequests7d}
                  sortKey={sort.key}
                  sortDesc={sort.desc}
                  onSort={onSort}
                  selectedId={selectedId}
                  onSelect={select}
                />
              }
              <UnmatchedTelemetry rows={index.unmatched} />
            </div>
            {selectedModel ?
              <ModelDetail
                key={selectedModel.id}
                model={selectedModel}
                telemetry={telemetryFor(selectedModel.id)}
                onClose={clearSelection}
              />
            : null}
          </div>
        </>
      }
    </div>
  )
}
