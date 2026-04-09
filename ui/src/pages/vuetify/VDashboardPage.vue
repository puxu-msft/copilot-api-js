<script setup lang="ts">
import { computed, ref } from "vue"

import CompactTimelineBarChart from "@/components/charts/CompactTimelineBarChart.vue"
import DashboardRateLimiterPanel from "@/components/dashboard/DashboardRateLimiterPanel.vue"
import { useFormatters } from "@/composables/useFormatters"
import { useDashboardStatus } from "@/composables/useDashboardStatus"
import { useInjectedHistoryStore } from "@/composables/useInjectedHistoryStore"
import { formatWsTargetStatus } from "@/utils/ws-status"

const store = useInjectedHistoryStore()
const { formatDate, formatDuration, formatNumber } = useFormatters()
const {
  auth,
  copilotExpiresAt,
  memory,
  quotaItems,
  quotaPlan,
  requestTelemetry,
  rateLimiter,
  rateLimiterColor,
  resolvedActiveCount,
  shutdownPhase,
  status,
  statusLoading,
  totalEvictedCount,
  uptime,
  wsConnected,
} = useDashboardStatus()

const statusLabel = computed(() => {
  const value = status.value?.status
  return typeof value === "string" ? value : "unknown"
})

const statusTone = computed(() => (statusLabel.value === "healthy" ? "success" : "error"))
const wsStatusLabel = computed(() => formatWsTargetStatus("requests + status", wsConnected.value))

const quotaResetDate = computed(() => {
  const value = (status.value?.quota as Record<string, unknown> | null)?.resetDate
  return typeof value === "string" ? value : null
})

const sessionTokens = computed(() => {
  const stats = store.stats.value
  if (!stats) return null
  return {
    input: stats.totalInputTokens,
    output: stats.totalOutputTokens,
    total: stats.totalInputTokens + stats.totalOutputTokens,
  }
})

const memorySummary = computed(() => {
  if (!memory.value) return null
  return {
    heapUsedMB: Number(memory.value.heapUsedMB ?? 0),
    heapLimitMB: Number(memory.value.heapLimitMB ?? 0),
    historyEntryCount: Number(memory.value.historyEntryCount ?? 0),
    historyMaxEntries: Number(memory.value.historyMaxEntries ?? 0),
  }
})

const heapUsagePercent = computed(() => {
  if (!memorySummary.value?.heapLimitMB) return 0
  return (memorySummary.value.heapUsedMB / memorySummary.value.heapLimitMB) * 100
})

const historyUsagePercent = computed(() => {
  if (!memorySummary.value?.historyMaxEntries) return 0
  return (memorySummary.value.historyEntryCount / memorySummary.value.historyMaxEntries) * 100
})

const requestBurstMaximum = computed(() => {
  const counts = requestTelemetry.value?.buckets.map((bucket) => bucket.count) ?? []
  return Math.max(...counts, 0)
})

type ModelTimelineMetric = "requests" | "duration" | "tokens"

const selectedModelTimelineMetric = ref<ModelTimelineMetric>("requests")
const selectedModelSortMetric = ref<ModelTimelineMetric>("requests")
const modelTimelineMetricOptions: Array<{ label: string; value: ModelTimelineMetric }> = [
  { label: "Requests", value: "requests" },
  { label: "Duration", value: "duration" },
  { label: "Tokens", value: "tokens" },
]

const modelTelemetryEntries = computed(() => {
  const runtimeEntries = requestTelemetry.value?.modelsSinceStart ?? []
  const rollingEntries = requestTelemetry.value?.modelsLast7d ?? []
  const rows = new Map<string, {
    model: string
    runtime: (typeof runtimeEntries)[number] | null
    last7d: (typeof rollingEntries)[number] | null
    displayCount: number
  }>()

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
      getModelMetricValue(right.last7d, selectedModelSortMetric.value)
      - getModelMetricValue(left.last7d, selectedModelSortMetric.value)
      || getModelMetricValue(right.runtime, selectedModelSortMetric.value)
      - getModelMetricValue(left.runtime, selectedModelSortMetric.value)
      || left.model.localeCompare(right.model),
  )
})

const maxModelMetricValue = computed(() =>
  Math.max(
    ...modelTelemetryEntries.value.map((item) => getModelMetricValue(item.last7d, selectedModelTimelineMetric.value)),
    1,
  ),
)
const MODEL_TIMELINE_TARGET_BUCKETS = 72

function relativeModelWidth(count: number): number {
  return maxModelMetricValue.value > 0 ? (count / maxModelMetricValue.value) * 100 : 0
}

function modelBarColor(model: string): string {
  const value = model.toLowerCase()
  if (value.includes("claude") || value.includes("anthropic")) return "#d299ff"
  if (value.includes("gpt") || value.includes("openai") || value.includes("o1") || value.includes("o3") || value.includes("o4")) {
    return "#7cc0ff"
  }
  if (value.includes("gemini")) return "#58d18d"
  return "#7cc0ff"
}

function compressModelTimeline(
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
      count: getModelBucketMetricValue(bucket, selectedModelTimelineMetric.value),
    }))
  }

  const groupSize = Math.ceil(buckets.length / MODEL_TIMELINE_TARGET_BUCKETS)
  const result: Array<{ timestamp: number; count: number }> = []

  for (let index = 0; index < buckets.length; index += groupSize) {
    const group = buckets.slice(index, index + groupSize)
    if (group.length === 0) continue
    result.push({
      timestamp: group[0].timestamp,
      count: group.reduce((sum, bucket) => sum + getModelBucketMetricValue(bucket, selectedModelTimelineMetric.value), 0),
    })
  }

  return result
}

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
  entry: {
    requestCount: number
    totalDurationMs: number
    usage: { totalTokens: number }
  } | null | undefined,
  metric: ModelTimelineMetric,
): number {
  if (!entry) return 0
  if (metric === "duration") return entry.totalDurationMs
  if (metric === "tokens") return entry.usage.totalTokens
  return entry.requestCount
}

function formatModelMetricValue(
  entry: {
    requestCount: number
    totalDurationMs: number
    usage: { totalTokens: number }
  } | null | undefined,
  metric: ModelTimelineMetric,
): string {
  if (!entry) return "-"
  if (metric === "duration") return formatDuration(entry.totalDurationMs)
  if (metric === "tokens") return `${formatNumber(entry.usage.totalTokens)} tok`
  return `${formatNumber(entry.requestCount)} req`
}
</script>

<template>
  <div class="ops-page v-page-root">
    <div
      v-if="statusLoading && !status"
      class="v-page-fill align-center justify-center"
    >
      <v-progress-circular
        indeterminate
        color="primary"
      />
    </div>

    <div
      v-else
      class="v-page-scroll"
    >
      <section class="hero-shell px-4 px-md-6 pt-5 pb-4">
        <div class="hero-grid">
          <div class="hero-copy">
            <div class="eyebrow text-caption font-weight-bold text-uppercase mb-3">
              Operations Workspace
            </div>
            <h1 class="hero-title">
              Dashboard and usage are now one surface.
            </h1>
            <p class="hero-body text-body-2 text-medium-emphasis">
              Monitor service health, rate limiting, quota pressure, memory headroom, model mix, and live requests
              without switching tabs.
            </p>
          </div>

          <div class="hero-rail">
            <v-chip
              :color="statusTone"
              variant="flat"
              class="hero-chip"
            >
              <v-icon
                start
                size="x-small"
                icon="mdi-heart-pulse"
              />
              {{ statusLabel }}
            </v-chip>
            <v-chip
              :color="wsConnected ? 'success' : 'error'"
              variant="tonal"
              class="hero-chip"
            >
              <v-icon
                start
                size="x-small"
                icon="mdi-connection"
              />
              {{ wsStatusLabel }}
            </v-chip>
            <v-chip
              color="secondary"
              variant="tonal"
              class="hero-chip"
            >
              <v-icon
                start
                size="x-small"
                icon="mdi-timer-outline"
              />
              {{ uptime }}
            </v-chip>
            <v-chip
              v-if="shutdownPhase !== 'idle'"
              color="warning"
              variant="flat"
              class="hero-chip"
            >
              <v-icon
                start
                size="x-small"
                icon="mdi-power"
              />
              {{ shutdownPhase }}
            </v-chip>
          </div>
        </div>
      </section>

      <section class="metric-band px-4 px-md-6 pb-4">
        <div class="metric-grid">
          <v-sheet
            class="metric-tile"
            color="surface"
            border
          >
            <div class="metric-label text-caption text-medium-emphasis text-uppercase">Active Requests</div>
            <div class="metric-value font-mono">{{ resolvedActiveCount }}</div>
            <div class="metric-foot text-caption text-medium-emphasis">Current in-flight upstream work.</div>
          </v-sheet>

          <v-sheet
            class="metric-tile"
            color="surface"
            border
          >
            <div class="metric-label text-caption text-medium-emphasis text-uppercase">Session Tokens</div>
            <div class="metric-value font-mono">{{ formatNumber(sessionTokens?.total) }}</div>
            <div class="metric-foot text-caption text-medium-emphasis">
              {{ formatNumber(sessionTokens?.input) }} in / {{ formatNumber(sessionTokens?.output) }} out
            </div>
          </v-sheet>

          <v-sheet
            class="metric-tile"
            color="surface"
            border
          >
            <div class="metric-label text-caption text-medium-emphasis text-uppercase">Accepted Requests</div>
            <div class="metric-value font-mono">{{ formatNumber(requestTelemetry?.acceptedSinceStart) }}</div>
            <div class="metric-foot text-caption text-medium-emphasis">
              {{ formatNumber(requestTelemetry?.totalLast7d) }} received in the last 7 days
            </div>
          </v-sheet>
        </div>
      </section>

      <section class="rate-limiter-shell px-4 px-md-6 pb-4">
        <DashboardRateLimiterPanel
          :rate-limiter="rateLimiter"
          :format-date="formatDate"
          :format-number="formatNumber"
          :rate-limiter-color="rateLimiterColor"
        />
      </section>

      <section class="workspace-grid px-4 px-md-6 pb-6">
        <v-sheet
          class="panel panel-quota"
          color="surface"
          border
        >
          <div class="panel-head">
            <div>
              <div class="panel-eyebrow text-caption text-medium-emphasis text-uppercase">Capacity</div>
              <div class="panel-title">Quota</div>
            </div>
          </div>

          <div
            v-if="quotaItems.length > 0"
            class="quota-stack"
          >
            <div
              v-if="quotaPlan"
              class="quota-plan text-caption text-medium-emphasis"
            >
              Current plan:
              <span class="text-high-emphasis font-weight-bold">{{ quotaPlan }}</span>
            </div>

            <div class="quota-meta">
              <div class="quota-meta-row">
                <span class="quota-meta-label">Quota Reset</span>
                <span class="quota-meta-value font-mono">{{ quotaResetDate ?? "-" }}</span>
              </div>
              <div class="quota-meta-row">
                <span class="quota-meta-label">Token Source</span>
                <span class="quota-meta-value">{{ auth?.tokenSource ?? "N/A" }}</span>
              </div>
              <div class="quota-meta-row">
                <span class="quota-meta-label">Token Expires</span>
                <span class="quota-meta-value font-mono">{{ copilotExpiresAt ?? "-" }}</span>
              </div>
            </div>

            <div
              v-for="item in quotaItems"
              :key="item.label"
              class="quota-row"
            >
              <div class="d-flex justify-space-between text-caption mb-1">
                <span>{{ item.label }}</span>
                <span class="font-mono">{{ formatNumber(item.used) }} / {{ formatNumber(item.total) }}</span>
              </div>
              <v-progress-linear
                :model-value="item.total > 0 ? (item.used / item.total) * 100 : 0"
                :color="item.total > 0 && item.used / item.total > 0.9 ? 'error' : 'primary'"
                bg-color="surface-variant"
                height="10"
              />
            </div>
          </div>
          <div
            v-else
            class="empty-panel text-caption text-medium-emphasis"
          >
            No quota data available.
          </div>
        </v-sheet>

        <v-sheet
          class="panel panel-memory"
          color="surface"
          border
        >
          <div class="panel-head">
            <div>
              <div class="panel-eyebrow text-caption text-medium-emphasis text-uppercase">Pressure</div>
              <div class="panel-title">Memory Pressure</div>
            </div>
          </div>
          <div
            v-if="memorySummary"
            class="memory-stack"
          >
            <div class="memory-block">
              <div class="d-flex justify-space-between text-caption mb-1">
                <span>Heap</span>
                <span class="font-mono">
                  {{ formatNumber(memorySummary.heapUsedMB) }} MB / {{ formatNumber(memorySummary.heapLimitMB) }} MB
                </span>
              </div>
              <v-progress-linear
                :model-value="heapUsagePercent"
                color="primary"
                bg-color="surface-variant"
                height="10"
              />
            </div>

            <div class="memory-block">
              <div class="d-flex justify-space-between text-caption mb-1">
                <span>History Cache</span>
                <span class="font-mono">
                  {{ formatNumber(memorySummary.historyEntryCount) }} / {{ formatNumber(memorySummary.historyMaxEntries) }}
                </span>
              </div>
              <v-progress-linear
                :model-value="historyUsagePercent"
                color="secondary"
                bg-color="surface-variant"
                height="10"
              />
            </div>

            <div class="text-caption text-medium-emphasis">
              Evicted entries:
              <span class="font-mono text-high-emphasis">{{ formatNumber(totalEvictedCount) }}</span>
            </div>
          </div>
          <div
            v-else
            class="empty-panel text-caption text-medium-emphasis"
          >
            No memory data available.
          </div>
        </v-sheet>

        <v-sheet
          class="panel panel-request-volume"
          color="surface"
          border
        >
          <div class="panel-head">
            <div>
              <div class="panel-eyebrow text-caption text-medium-emphasis text-uppercase">Traffic Volume</div>
              <div class="panel-title">Accepted Requests</div>
            </div>
            <div class="text-caption text-medium-emphasis">
              {{ requestTelemetry?.bucketSizeMinutes ?? 5 }} min buckets · {{ requestTelemetry?.windowDays ?? 7 }} days
            </div>
          </div>

          <div
            v-if="requestTelemetry && requestTelemetry.buckets.length > 0"
            class="request-volume-stack"
          >
            <div class="request-volume-summary">
              <div class="request-volume-stat">
                <span class="request-volume-label">Since startup</span>
                <span class="request-volume-value font-mono">{{ formatNumber(requestTelemetry.acceptedSinceStart) }}</span>
              </div>
              <div class="request-volume-stat">
                <span class="request-volume-label">Last 7d total</span>
                <span class="request-volume-value font-mono">{{ formatNumber(requestTelemetry.totalLast7d) }}</span>
              </div>
              <div class="request-volume-stat">
                <span class="request-volume-label">Peak 5m</span>
                <span class="request-volume-value font-mono">{{ formatNumber(requestBurstMaximum) }}</span>
              </div>
            </div>

            <CompactTimelineBarChart :data="requestTelemetry.buckets" />
          </div>
          <div
            v-else
            class="empty-panel text-caption text-medium-emphasis"
          >
            No accepted-request telemetry available yet.
          </div>
        </v-sheet>

        <v-sheet
          class="panel panel-traffic"
          color="surface"
          border
        >
          <div class="panel-head">
            <div>
              <div class="panel-eyebrow text-caption text-medium-emphasis text-uppercase">Traffic Mix</div>
              <div class="panel-title">Model Telemetry</div>
            </div>
            <div class="traffic-toolbar">
              <div class="text-caption text-medium-emphasis">
                7d persisted + runtime
              </div>
              <div class="traffic-toggle-group">
                <div class="traffic-toggle-label text-caption text-medium-emphasis">Chart</div>
                <v-btn-toggle
                  v-model="selectedModelTimelineMetric"
                  mandatory
                  density="compact"
                  color="primary"
                  variant="outlined"
                  divided
                  class="traffic-toggle"
                >
                  <v-btn
                    v-for="option in modelTimelineMetricOptions"
                    :key="`chart-${option.value}`"
                    :value="option.value"
                    size="small"
                  >
                    {{ option.label }}
                  </v-btn>
                </v-btn-toggle>
              </div>
              <div class="traffic-toggle-group">
                <div class="traffic-toggle-label text-caption text-medium-emphasis">Sort</div>
                <v-btn-toggle
                  v-model="selectedModelSortMetric"
                  mandatory
                  density="compact"
                  color="secondary"
                  variant="outlined"
                  divided
                  class="traffic-toggle"
                >
                  <v-btn
                    v-for="option in modelTimelineMetricOptions"
                    :key="`sort-${option.value}`"
                    :value="option.value"
                    size="small"
                  >
                    {{ option.label }}
                  </v-btn>
                </v-btn-toggle>
              </div>
            </div>
          </div>

          <div
            v-if="modelTelemetryEntries.length > 0"
            class="traffic-stack"
          >
            <div
              v-for="item in modelTelemetryEntries"
              :key="item.model"
              class="traffic-row"
            >
              <div class="traffic-meta">
                <span
                  class="traffic-model text-caption"
                  :title="item.model"
                >
                  {{ item.model }}
                </span>
                <span class="text-caption text-medium-emphasis">
                  {{ formatModelMetricValue(item.last7d, selectedModelTimelineMetric) }} / 7d
                </span>
              </div>
              <div class="traffic-subline">
                <span>7d avg {{ formatDuration(item.last7d?.averageDurationMs ?? null) }}</span>
                <span>{{ formatNumber(item.last7d?.usage.totalTokens) }} tok</span>
                <span>{{ item.last7d?.successCount ?? 0 }} ok / {{ item.last7d?.failureCount ?? 0 }} fail</span>
              </div>
              <CompactTimelineBarChart
                v-if="item.last7d?.buckets?.length"
                :data="compressModelTimeline(item.last7d.buckets)"
                :height="34"
                :show-axis="false"
                :color="`linear-gradient(180deg, ${modelBarColor(item.model)}, rgba(255, 255, 255, 0.18))`"
                class="traffic-timeline"
              />
              <v-progress-linear
                :model-value="relativeModelWidth(getModelMetricValue(item.last7d, selectedModelTimelineMetric))"
                :color="modelBarColor(item.model)"
                bg-color="surface-variant"
                height="14"
                class="traffic-bar"
              />
              <div class="traffic-subline text-disabled">
                <span>Runtime {{ formatNumber(item.runtime?.requestCount) }} req</span>
                <span>{{ formatNumber(item.runtime?.usage.totalTokens) }} tok</span>
                <span>{{ formatDuration(item.runtime?.totalDurationMs) }} total</span>
              </div>
            </div>
          </div>
          <div
            v-else
            class="empty-panel text-caption text-medium-emphasis"
          >
            No model telemetry available yet.
          </div>
        </v-sheet>
      </section>

    </div>
  </div>
</template>

<style scoped>
.ops-page {
  background:
    radial-gradient(circle at top right, rgb(var(--v-theme-primary) / 16%), transparent 28%),
    linear-gradient(180deg, rgb(var(--v-theme-background)) 0%, rgb(var(--v-theme-surface)) 100%);
}

.hero-shell {
  position: relative;
}

.hero-shell::after {
  content: "";
  position: absolute;
  inset: 0;
  background:
    linear-gradient(135deg, rgb(var(--v-theme-surface)) 0%, rgb(var(--v-theme-surface-variant)) 100%);
  opacity: 0.92;
  pointer-events: none;
}

.hero-grid {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(260px, 0.9fr);
  gap: 24px;
  align-items: end;
}

.eyebrow,
.panel-eyebrow,
.metric-label {
  letter-spacing: 0.08em;
}

.hero-title {
  margin: 0;
  max-width: 11ch;
  font-size: clamp(2.25rem, 4vw, 3.8rem);
  line-height: 0.95;
  letter-spacing: -0.05em;
}

.hero-body {
  max-width: 56ch;
  margin: 16px 0 0;
}

.hero-rail {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
}

.hero-chip {
  backdrop-filter: blur(6px);
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.metric-tile,
.panel {
  padding: 18px;
  border-color: rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
}

.metric-tile {
  min-height: 126px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.metric-value {
  font-size: clamp(1.5rem, 2vw, 2rem);
  line-height: 1;
  letter-spacing: -0.04em;
}

.metric-foot {
  min-height: 20px;
}

.workspace-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}

.rate-limiter-shell {
  padding-top: 2px;
}

.panel-head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.panel-title {
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.traffic-toolbar {
  display: flex;
  flex-direction: column;
  align-items: end;
  gap: 10px;
}

.traffic-toggle-group {
  display: flex;
  align-items: center;
  gap: 10px;
}

.traffic-toggle-label {
  min-width: 34px;
  text-align: right;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.traffic-toggle :deep(.v-btn) {
  min-width: 0;
  padding-inline: 10px;
}

.quota-stack,
.memory-stack,
.request-volume-stack,
.traffic-stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.quota-plan {
  margin-bottom: 2px;
}

.quota-meta {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 0 2px;
}

.quota-meta-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 10px;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

.quota-meta-label {
  color: rgb(var(--v-theme-secondary));
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
}

.quota-meta-value {
  text-align: right;
  font-size: 0.95rem;
}

.memory-block,
.request-volume-summary,
.traffic-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.request-volume-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.request-volume-stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border: 1px solid rgb(var(--v-theme-surface-variant));
}

.request-volume-label {
  font-size: 0.74rem;
  line-height: 1.2;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: rgb(var(--v-theme-secondary));
}

.request-volume-value {
  font-size: 1.02rem;
  line-height: 1.15;
  font-weight: 700;
}

.traffic-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.traffic-model {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.traffic-subline {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: 0.75rem;
  line-height: 1.3;
  color: rgb(var(--v-theme-secondary));
}

.traffic-timeline {
  padding: 4px 0 2px;
}

.empty-panel,
.empty-state {
  padding: 16px 0 6px;
}

.empty-title {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 6px;
}

@media (max-width: 1100px) {
  .metric-grid,
  .workspace-grid,
  .hero-grid {
    grid-template-columns: 1fr;
  }

  .hero-rail {
    justify-content: flex-start;
  }
}

@media (max-width: 700px) {
  .metric-tile,
  .panel {
    padding: 16px;
  }

  .hero-title {
    max-width: none;
  }

  .request-volume-summary {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 520px) {
  .quota-meta-row,
  .traffic-meta,
  .traffic-subline {
    flex-direction: column;
    align-items: start;
  }

  .traffic-toolbar {
    align-items: start;
  }

  .traffic-toggle-group {
    flex-wrap: wrap;
  }

  .traffic-toggle-label {
    text-align: left;
  }

  .quota-meta-value {
    text-align: left;
  }
}
</style>
