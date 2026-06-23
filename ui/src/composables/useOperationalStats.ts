import {
  //
  computed,
  type Ref,
} from "vue"

import type { DimensionBreakdownSnapshot } from "@/types"

import { api } from "@/api/http"
import { usePolling } from "@/composables/usePolling"

/** The operational dimensions surfaced on the dashboard (model keeps its dedicated panel). */
const OPERATIONAL_DIMENSIONS = ["endpoint", "client", "agentKind", "tool"] as const
type OperationalDimension = (typeof OPERATIONAL_DIMENSIONS)[number]

export type OperationalStatsBundle = Record<OperationalDimension, DimensionBreakdownSnapshot | null>

export interface UseOperationalStatsReturn {
  endpoint: Ref<DimensionBreakdownSnapshot | null>
  client: Ref<DimensionBreakdownSnapshot | null>
  agentKind: Ref<DimensionBreakdownSnapshot | null>
  tool: Ref<DimensionBreakdownSnapshot | null>
  loading: Ref<boolean>
  error: Ref<string | null>
}

/**
 * Poll the `/api/stats` breakdowns for the operational dimensions in parallel.
 * Each dimension is fetched with `window=7d` + a server-side top-N so the payload
 * stays bounded even for the high-cardinality client/tool dimensions. The model
 * dimension is NOT fetched here — it keeps its dedicated `useModelTelemetry` panel
 * fed off `/api/status`.
 */
export function useOperationalStats(window: "sinceStart" | "7d" = "7d", limit = 12, intervalMs = 10_000): UseOperationalStatsReturn {
  const { data, loading, error } = usePolling<OperationalStatsBundle>(async () => {
    const results = await Promise.all(OPERATIONAL_DIMENSIONS.map((dimension) => api.fetchDimensionStats(dimension, window, limit).catch(() => null)))
    return Object.fromEntries(OPERATIONAL_DIMENSIONS.map((dimension, index) => [dimension, results[index]])) as OperationalStatsBundle
  }, intervalMs)

  const pick = (dimension: OperationalDimension): Ref<DimensionBreakdownSnapshot | null> =>
    computed(() => data.value?.[dimension] ?? null) as Ref<DimensionBreakdownSnapshot | null>

  return {
    endpoint: pick("endpoint"),
    client: pick("client"),
    agentKind: pick("agentKind"),
    tool: pick("tool"),
    loading,
    error: error,
  }
}

/** Sum a counter across all keys of a breakdown (e.g. total requestCount for the share calc). */
export function sumBreakdownCounter(breakdown: DimensionBreakdownSnapshot | null, counter: string): number {
  if (!breakdown) return 0
  return breakdown.keys.reduce((sum, key) => sum + (key.counters[counter] ?? 0), 0)
}
