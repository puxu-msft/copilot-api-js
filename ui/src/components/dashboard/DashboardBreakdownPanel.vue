<script setup lang="ts">
import { computed } from "vue"

import type { DimensionBreakdownSnapshot } from "@/types"

import { formatNumber } from "@/utils/formatters"

const props = defineProps<{
  /** Section eyebrow (e.g. "Traffic"), title (e.g. "Per Endpoint"), and the breakdown payload. */
  eyebrow: string
  title: string
  breakdown: DimensionBreakdownSnapshot | null
  /** Which counter drives the bars (default requestCount). */
  metric?: string
  /** Empty-state copy. */
  emptyText?: string
}>()

const metricKey = computed(() => props.metric ?? "requestCount")

interface BreakdownRow {
  key: string
  value: number
  requestCount: number
  totalTokens: number
  costTokens: number
  share: number
  p50: number | null
  p95: number | null
}

const rows = computed<Array<BreakdownRow>>(() => {
  const keys = props.breakdown?.keys ?? []
  const max = Math.max(...keys.map((entry) => entry.counters[metricKey.value] ?? 0), 1)
  return keys.map((entry) => {
    const counters = entry.counters
    const value = counters[metricKey.value] ?? 0
    const costTokens =
      (counters.costInputTokens ?? 0)
      + (counters.costOutputTokens ?? 0)
      + (counters.costCacheReadInputTokens ?? 0)
      + (counters.costCacheCreationInputTokens ?? 0)
      + (counters.costReasoningTokens ?? 0)
    const latency = entry.histograms?.duration_ms
    return {
      key: entry.key,
      value,
      requestCount: counters.requestCount ?? 0,
      totalTokens: (counters.inputTokens ?? 0) + (counters.outputTokens ?? 0),
      costTokens,
      share: (value / max) * 100,
      p50: latency ? Math.round(latency.p50) : null,
      p95: latency ? Math.round(latency.p95) : null,
    }
  })
})

const hasCost = computed(() => rows.value.some((row) => row.costTokens > 0))
const hasLatency = computed(() => rows.value.some((row) => row.p50 !== null))

function barColor(key: string): string {
  if (key === "other") return "secondary"
  if (key === "main") return "primary"
  if (key === "subagent") return "info"
  return "primary"
}
</script>

<template>
  <v-sheet
    class="panel breakdown-panel"
    color="surface"
    border
  >
    <div class="panel-head">
      <div>
        <div class="panel-eyebrow text-caption text-medium-emphasis text-uppercase">{{ eyebrow }}</div>
        <div class="panel-title">{{ title }}</div>
      </div>
      <div
        v-if="breakdown"
        class="text-caption text-medium-emphasis"
      >
        {{ formatNumber(breakdown.totalKeys) }} keys<span v-if="breakdown.truncated"> · top {{ rows.length }}</span>
      </div>
    </div>

    <div
      v-if="rows.length > 0"
      class="breakdown-stack"
    >
      <div
        v-for="row in rows"
        :key="row.key"
        class="breakdown-row"
      >
        <div class="d-flex justify-space-between text-caption mb-1">
          <span
            class="breakdown-key"
            :title="row.key"
          >
            <v-icon
              :color="barColor(row.key)"
              size="x-small"
              icon="mdi-circle"
              class="mr-1"
            />
            {{ row.key }}
          </span>
          <span class="font-mono">{{ formatNumber(row.value) }}</span>
        </div>
        <v-progress-linear
          :model-value="row.share"
          :color="barColor(row.key)"
          bg-color="surface-variant"
          height="10"
        />
        <div class="breakdown-subline text-disabled">
          <span>{{ formatNumber(row.requestCount) }} req</span>
          <span>{{ formatNumber(row.totalTokens) }} tok</span>
          <span v-if="hasCost">{{ formatNumber(Math.round(row.costTokens)) }} cost</span>
          <span v-if="hasLatency && row.p50 !== null">p50 {{ row.p50 }}ms · p95 {{ row.p95 }}ms</span>
        </div>
      </div>
    </div>
    <div
      v-else
      class="empty-panel text-caption text-medium-emphasis"
    >
      {{ emptyText ?? "No data available yet." }}
    </div>
  </v-sheet>
</template>

<style scoped>
.panel {
  padding: 18px;
  border-color: rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
}

.panel-head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.panel-eyebrow {
  letter-spacing: 0.08em;
}

.panel-title {
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.breakdown-stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.breakdown-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.breakdown-key {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  max-width: 70%;
}

.breakdown-subline {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: 0.72rem;
  line-height: 1.3;
  color: rgb(var(--v-theme-secondary));
}

.empty-panel {
  padding: 16px 0 6px;
}
</style>
