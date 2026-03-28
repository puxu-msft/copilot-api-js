<script setup lang="ts">
import { computed } from "vue"

import { api } from "@/api/http"
import { useFormatters } from "@/composables/useFormatters"
import { useInjectedHistoryStore } from "@/composables/useInjectedHistoryStore"
import { usePolling } from "@/composables/usePolling"

const store = useInjectedHistoryStore()
const { formatNumber } = useFormatters()

const { data: status } = usePolling(() => api.fetchStatus(), 10000)

/** Quota section from status */
const quota = computed(() => {
  if (!status.value?.quota) return null
  return status.value.quota as Record<string, unknown>
})

/** Account info */
const account = computed(() => {
  if (!status.value?.auth) return null
  return status.value.auth as Record<string, unknown>
})

interface QuotaItem {
  label: string
  used: number
  limit: number
}

const quotaItems = computed<Array<QuotaItem>>(() => {
  if (!quota.value) return []
  const items: Array<QuotaItem> = []
  const raw = quota.value

  if (raw.premiumInteractions) {
    const pi = raw.premiumInteractions as Record<string, number>
    items.push({
      label: "Premium Interactions",
      used: pi.used ?? 0,
      limit: pi.limit ?? 0,
    })
  }
  if (raw.chat) {
    const chat = raw.chat as Record<string, number>
    items.push({ label: "Chat", used: chat.used ?? 0, limit: chat.limit ?? 0 })
  }
  if (raw.completions) {
    const comp = raw.completions as Record<string, number>
    items.push({
      label: "Completions",
      used: comp.used ?? 0,
      limit: comp.limit ?? 0,
    })
  }

  return items
})

const resetDate = computed(() => {
  if (!quota.value?.resetDate) return null
  return String(quota.value.resetDate)
})

/** Session token totals from stats */
const sessionTokens = computed(() => {
  const stats = store.stats.value
  if (!stats) return null
  return {
    input: stats.totalInputTokens,
    output: stats.totalOutputTokens,
  }
})

/** Model distribution from stats */
const modelDistribution = computed<Record<string, number>>(() => {
  return store.stats.value?.modelDistribution ?? {}
})

/** Sorted model distribution entries for display */
const modelDistributionEntries = computed(() => {
  const dist = modelDistribution.value
  const entries = Object.entries(dist)
  if (entries.length === 0) return []
  const total = entries.reduce((sum, [, count]) => sum + count, 0)
  return entries
    .sort(([, a], [, b]) => b - a)
    .map(([model, count]) => ({
      model,
      count,
      percent: total > 0 ? (count / total) * 100 : 0,
    }))
})

/** Max count for relative bar sizing */
const maxModelCount = computed(() => {
  if (modelDistributionEntries.value.length === 0) return 1
  return modelDistributionEntries.value[0].count
})

/** Model bar color (direct hex, since not all are Vuetify theme colors) */
function modelBarColor(model: string): string {
  const m = model.toLowerCase()
  if (m.includes("claude") || m.includes("anthropic")) return "#a371f7"
  if (m.includes("gpt") || m.includes("openai") || m.includes("o1") || m.includes("o3") || m.includes("o4"))
    return "#58a6ff"
  if (m.includes("gemini")) return "#3fb950"
  return "#58a6ff"
}
</script>

<template>
  <div class="d-flex flex-column fill-height">
    <div class="flex-grow-1 overflow-y-auto">
      <!-- Account + Quota header row -->
      <div class="header-row px-4 py-3 d-flex align-center flex-wrap ga-4">
        <div
          v-if="account"
          class="d-flex align-center ga-3"
        >
          <div class="d-flex align-center ga-1">
            <span class="text-caption text-medium-emphasis">Plan</span>
            <span class="text-body-2 font-weight-bold">{{ account.accountType }}</span>
          </div>
          <div
            v-if="resetDate"
            class="d-flex align-center ga-1"
          >
            <span class="text-caption text-medium-emphasis">Resets</span>
            <span class="text-caption mono">{{ resetDate }}</span>
          </div>
        </div>
        <v-spacer />
        <div
          v-if="sessionTokens"
          class="d-flex align-center ga-3"
        >
          <div class="d-flex align-center ga-1">
            <span class="text-caption text-medium-emphasis">Session In</span>
            <span class="text-caption mono font-weight-bold">{{ formatNumber(sessionTokens.input) }}</span>
          </div>
          <div class="d-flex align-center ga-1">
            <span class="text-caption text-medium-emphasis">Out</span>
            <span class="text-caption mono font-weight-bold">{{ formatNumber(sessionTokens.output) }}</span>
          </div>
          <div class="d-flex align-center ga-1">
            <span class="text-caption text-medium-emphasis">Total</span>
            <span class="text-caption mono font-weight-bold">{{
              formatNumber(sessionTokens.input + sessionTokens.output)
            }}</span>
          </div>
        </div>
      </div>

      <v-divider />

      <div class="content-area pa-4">
        <!-- Quota progress bars — full width -->
        <div
          v-if="quotaItems.length > 0"
          class="mb-6"
        >
          <div class="section-header text-caption font-weight-bold text-medium-emphasis text-uppercase mb-3">Quota</div>
          <div
            v-for="item in quotaItems"
            :key="item.label"
            class="quota-row mb-3"
          >
            <div class="d-flex justify-space-between text-caption mb-1">
              <span>{{ item.label }}</span>
              <span class="mono">{{ formatNumber(item.used) }} / {{ formatNumber(item.limit) }}</span>
            </div>
            <v-progress-linear
              :model-value="item.limit > 0 ? (item.used / item.limit) * 100 : 0"
              :color="item.limit > 0 && item.used / item.limit > 0.9 ? 'error' : 'primary'"
              rounded
              height="8"
              bg-color="surface-variant"
            />
          </div>
        </div>

        <!-- Model Distribution — horizontal bars -->
        <div v-if="modelDistributionEntries.length > 0">
          <div class="section-header text-caption font-weight-bold text-medium-emphasis text-uppercase mb-3">
            Model Distribution
          </div>
          <div class="model-dist-list">
            <div
              v-for="item in modelDistributionEntries"
              :key="item.model"
              class="model-dist-row d-flex align-center ga-3 mb-2"
            >
              <span class="model-name mono text-caption">{{ item.model }}</span>
              <div class="bar-wrap flex-grow-1">
                <div
                  class="bar-fill"
                  :style="{
                    width: `${(item.count / maxModelCount) * 100}%`,
                    backgroundColor: modelBarColor(item.model),
                  }"
                />
              </div>
              <span class="model-count mono text-caption text-medium-emphasis">
                {{ item.count }}
              </span>
              <span class="model-pct mono text-caption text-disabled"> {{ item.percent.toFixed(1) }}% </span>
            </div>
          </div>
        </div>

        <!-- Empty state -->
        <div
          v-if="quotaItems.length === 0 && modelDistributionEntries.length === 0 && !sessionTokens"
          class="d-flex align-center justify-center"
          style="min-height: 200px"
        >
          <span class="text-medium-emphasis">No usage data available</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mono {
  font-family: "SF Mono", Monaco, "Courier New", monospace;
}

.header-row {
  background: rgb(var(--v-theme-surface-variant));
}

.section-header {
  letter-spacing: 0.05em;
}

.content-area {
  max-width: 900px;
}

.model-dist-list {
  /* No card wrapping — just clean rows */
}

.model-name {
  min-width: 220px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar-wrap {
  height: 16px;
  background: rgb(var(--v-theme-surface-variant));
  border-radius: 2px;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: 2px;
  min-width: 2px;
  transition: width 0.3s ease;
}

.model-count {
  min-width: 36px;
  text-align: right;
}

.model-pct {
  min-width: 52px;
  text-align: right;
}
</style>
