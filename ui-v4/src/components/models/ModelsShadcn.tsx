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
import { ModelDetailShadcn } from "@/components/models/ModelDetailShadcn"
import { ModelsColumnMenuShadcn } from "@/components/models/ModelsColumnMenuShadcn"
import { ModelsFilterBarShadcn } from "@/components/models/ModelsFilterBarShadcn"
import { ModelsTableShadcn } from "@/components/models/ModelsTableShadcn"
import { UnmatchedTelemetry } from "@/components/models/UnmatchedTelemetry"
import { Button } from "@/components/ui/button"
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

/** shadcn 列可见性持久化键(与 legacy 独立,避免双树互相污染;共享 vs 独立是 UX 取舍 → 交用户)。 */
const COLUMNS_KEY = "copilot-api-ui-v4-models-columns-shadcn"

function loadColumns(): ModelColumnVisibility {
  try {
    return mergeColumnVisibility(JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? "null") as Partial<ModelColumnVisibility> | null)
  } catch {
    return { ...DEFAULT_COLUMN_VISIBILITY }
  }
}

/**
 * fork B · Models shadcn 页元素(完整)。与 legacy(`ModelsLegacy`)读**同一数据/构建器层**
 * (`useModels`/`useModelTelemetry`/`filterModels`/`modelStatus`/`buildModelTelemetryIndex`,A)+ `?model=<id>`
 * URL 选中(URL-as-truth),仅呈现层不同:shadcn `Input`/`Select`/`DropdownMenu` filter/column 菜单 +
 * 中性表格 `ModelsTableShadcn` + 选中开 **抽屉** `ModelDetailShadcn`(shadcn `Dialog` chrome 各自实现,内嵌
 * `HorizontalTabs` 6 tab 横排替竖排 sub-rail)。行内容体(model-table-columns/detail-tabs,B/A′)逐字复用。
 * `data-testid=models-shadcn` 供 fork B 互斥挂载守卫。本文件零设计版本标识符。
 */
export function ModelsShadcn() {
  const { data, isLoading, isError, error } = useModels()
  const { data: telemetry } = useModelTelemetry()
  const [searchParams, setSearchParams] = useSearchParams()
  const [raw, setRaw] = useState(false)
  const [columns, setColumns] = useState<ModelColumnVisibility>(loadColumns)
  const [filters, setFilters] = useState<ModelFilters>(EMPTY_FILTERS)
  const [sorting, setSorting] = useState<SortingState>([{ id: "id", desc: false }])

  useEffect(() => {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify(columns))
  }, [columns])

  const models = useMemo(() => data?.data ?? [], [data])

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

  // 选中 URL 化(`?model=<id>`):对**全量 catalog**(非筛选后视图)解析,故 deep link 即使被筛掉也能打开。
  const selectedId = searchParams.get("model")
  const selectedModel = useMemo(() => (selectedId ? (models.find((m) => m.id === selectedId) ?? null) : null), [models, selectedId])
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

  const visible = useMemo(() => filterModels(models, filters, hasTelemetry, statusFor), [models, filters, hasTelemetry, statusFor])
  const billingBounds = useMemo(() => modelBillingBounds(models), [models])

  const onChange = (patch: Partial<ModelFilters>) => setFilters((f) => ({ ...f, ...patch }))
  const toggleColumn = (key: ModelColumnKey) => setColumns((c) => ({ ...c, [key]: !c[key] }))
  const resetColumns = () => setColumns({ ...DEFAULT_COLUMN_VISIBILITY })

  if (isLoading) return <div className="mono p-4 text-muted-foreground">loading…</div>
  if (isError)
    return (
      <div className="mono flex flex-col gap-1 p-4 text-destructive">
        <div>⚠ failed to load models</div>
        <div className="text-[12px] text-muted-foreground">{error instanceof Error ? error.message : String(error)}</div>
      </div>
    )

  return (
    <div
      data-testid="models-shadcn"
      className="mono flex min-h-0 flex-1 flex-col text-[13px] text-foreground"
    >
      <div className="flex items-center gap-2 border-b border-border px-2 py-1">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Models · {visible.length}/{models.length} · {options.vendors.length} vendors · {options.endpoints.length} endpoints
        </div>
        <div className="ml-auto flex items-center gap-2">
          <ModelsColumnMenuShadcn
            columns={columns}
            onToggle={toggleColumn}
            onReset={resetColumns}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setRaw((v) => !v)}
          >
            {raw ? "table" : "raw JSON"}
          </Button>
        </div>
      </div>

      {raw ?
        <RawJsonView value={data ?? { data: [] }} />
      : <>
          <ModelsFilterBarShadcn
            filters={filters}
            onChange={onChange}
            options={options}
            billingBounds={billingBounds}
          />
          <div className="min-h-0 flex-1 overflow-auto">
            {visible.length === 0 ?
              <div className="p-4 text-muted-foreground">
                {models.length === 0 ?
                  "No models in the catalog."
                : <>
                    No models match the current filters.
                    <div className="mt-1 text-[12px] text-muted-foreground">Try relaxing your search or clearing a filter.</div>
                  </>
                }
              </div>
            : <ModelsTableShadcn
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
          {/* 抽屉(Radix Dialog portal)—— 覆盖全宽表格,而非同 flex 行挤压。 */}
          {selectedModel ?
            <ModelDetailShadcn
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
