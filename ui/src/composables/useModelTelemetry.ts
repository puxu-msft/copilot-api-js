import {
  //
  computed,
  ref,
  type ComputedRef,
  type Ref,
} from "vue"

import {
  //
  formatDuration,
  formatNumber,
} from "@/utils/formatters"

import type { RequestTelemetrySnapshot } from "./useDashboardStatus"

export type ModelTimelineMetric = "requests" | "duration" | "tokens"

export interface ModelTelemetryEntry {
  model: string
  runtime: ModelStatsRow | null
  last7d: ModelSeriesRow | null
  displayCount: number
}

type ModelStatsRow = NonNullable<RequestTelemetrySnapshot["modelsSinceStart"]>[number]
type ModelSeriesRow = NonNullable<RequestTelemetrySnapshot["modelsLast7d"]>[number]

const MODEL_TIMELINE_TARGET_BUCKETS = 72

const modelTimelineMetricOptions: Array<{ label: string; value: ModelTimelineMetric }> = [
  { label: "Requests", value: "requests" },
  { label: "Duration", value: "duration" },
  { label: "Tokens", value: "tokens" },
]

function getModelBucketMetricValue(
  bucket: {
    requestCount: number
    totalDurationMs: number
    usage: { totalTokens: number }
  },
  metric: ModelTimelineMetric,
): number {
  if (metric === "duration") return bucket.totalDurationMs
  if (metric === "tokens") return bucket.usage.totalTokens
  return bucket.requestCount
}

function getModelMetricValue(
  entry:
    | {
        requestCount: number
        totalDurationMs: number
        usage: { totalTokens: number }
      }
    | null
    | undefined,
  metric: ModelTimelineMetric,
): number {
  if (!entry) return 0
  if (metric === "duration") return entry.totalDurationMs
  if (metric === "tokens") return entry.usage.totalTokens
  return entry.requestCount
}

function formatModelMetricValue(
  entry:
    | {
        requestCount: number
        totalDurationMs: number
        usage: { totalTokens: number }
      }
    | null
    | undefined,
  metric: ModelTimelineMetric,
): string {
  if (!entry) return "-"
  if (metric === "duration") return formatDuration(entry.totalDurationMs)
  if (metric === "tokens") return `${formatNumber(entry.usage.totalTokens)} tok`
  return `${formatNumber(entry.requestCount)} req`
}

function modelBarColor(model: string): string {
  const value = model.toLowerCase()
  if (value.includes("claude") || value.includes("anthropic")) return "#c8a0d8"
  if (value.includes("gpt") || value.includes("openai") || value.includes("o1") || value.includes("o3") || value.includes("o4")) {
    return "#7ab8d0"
  }
  if (value.includes("gemini")) return "#5cb870"
  return "#d4a04a"
}

export interface UseModelTelemetryReturn {
  selectedChartMetric: Ref<ModelTimelineMetric>
  selectedSortMetric: Ref<ModelTimelineMetric>
  metricOptions: typeof modelTimelineMetricOptions
  modelTelemetryEntries: ComputedRef<Array<ModelTelemetryEntry>>
  maxMetricValue: ComputedRef<number>
  relativeWidth: (count: number) => number
  barColor: typeof modelBarColor
  formatMetricValue: typeof formatModelMetricValue
  getMetricValue: typeof getModelMetricValue
  compressTimeline: (
    buckets: Array<{
      timestamp: number
      requestCount: number
      totalDurationMs: number
      usage: { totalTokens: number }
    }>,
  ) => Array<{ timestamp: number; count: number }>
}

/** Extract model telemetry logic from VDashboardPage */
export function useModelTelemetry(
  requestTelemetry: Ref<RequestTelemetrySnapshot | null> | ComputedRef<RequestTelemetrySnapshot | null>,
): UseModelTelemetryReturn {
  const selectedChartMetric = ref<ModelTimelineMetric>("requests")
  const selectedSortMetric = ref<ModelTimelineMetric>("requests")

  const modelTelemetryEntries = computed<Array<ModelTelemetryEntry>>(() => {
    const runtimeEntries = requestTelemetry.value?.modelsSinceStart ?? []
    const rollingEntries = requestTelemetry.value?.modelsLast7d ?? []
    const rows = new Map<string, ModelTelemetryEntry>()

    for (const entry of runtimeEntries) {
      rows.set(entry.model, {
        model: entry.model,
        runtime: entry,
        last7d: null,
        displayCount: entry.requestCount,
      })
    }

    for (const entry of rollingEntries) {
      const existing = rows.get(entry.model)
      if (existing) {
        existing.last7d = entry
        existing.displayCount = Math.max(existing.displayCount, entry.requestCount)
      } else {
        rows.set(entry.model, {
          model: entry.model,
          runtime: null,
          last7d: entry,
          displayCount: entry.requestCount,
        })
      }
    }

    return [...rows.values()].sort(
      (left, right) =>
        getModelMetricValue(right.last7d, selectedSortMetric.value) - getModelMetricValue(left.last7d, selectedSortMetric.value)
        || getModelMetricValue(right.runtime, selectedSortMetric.value) - getModelMetricValue(left.runtime, selectedSortMetric.value)
        || left.model.localeCompare(right.model),
    )
  })

  const maxMetricValue = computed(() => Math.max(...modelTelemetryEntries.value.map((item) => getModelMetricValue(item.last7d, selectedChartMetric.value)), 1))

  function relativeWidth(count: number): number {
    return maxMetricValue.value > 0 ? (count / maxMetricValue.value) * 100 : 0
  }

  function compressTimeline(
    buckets: Array<{
      timestamp: number
      requestCount: number
      totalDurationMs: number
      usage: { totalTokens: number }
    }>,
  ): Array<{ timestamp: number; count: number }> {
    if (buckets.length <= MODEL_TIMELINE_TARGET_BUCKETS) {
      return buckets.map((bucket) => ({
        timestamp: bucket.timestamp,
        count: getModelBucketMetricValue(bucket, selectedChartMetric.value),
      }))
    }

    const groupSize = Math.ceil(buckets.length / MODEL_TIMELINE_TARGET_BUCKETS)
    const result: Array<{ timestamp: number; count: number }> = []

    for (let index = 0; index < buckets.length; index += groupSize) {
      const group = buckets.slice(index, index + groupSize)
      if (group.length === 0) continue
      result.push({
        timestamp: group[0].timestamp,
        count: group.reduce((sum, bucket) => sum + getModelBucketMetricValue(bucket, selectedChartMetric.value), 0),
      })
    }

    return result
  }

  return {
    selectedChartMetric,
    selectedSortMetric,
    metricOptions: modelTimelineMetricOptions,
    modelTelemetryEntries,
    maxMetricValue,
    relativeWidth,
    barColor: modelBarColor,
    formatMetricValue: formatModelMetricValue,
    getMetricValue: getModelMetricValue,
    compressTimeline,
  }
}
