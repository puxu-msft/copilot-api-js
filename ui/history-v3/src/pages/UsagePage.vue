<script setup lang="ts">
/** @deprecated Use VUsagePage.vue (`/v/usage`) for ongoing UI work. */
import { computed } from "vue"

import { api } from "@/api/http"
import HorizontalBar from "@/components/charts/HorizontalBar.vue"
import DataCard from "@/components/ui/DataCard.vue"
import ProgressBar from "@/components/ui/ProgressBar.vue"
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
</script>

<template>
  <div class="usage-page">
    <div class="usage-header">
      <h2 class="usage-title">Usage</h2>
    </div>

    <div class="usage-content">
      <!-- Account Info -->
      <DataCard title="Account">
        <div
          v-if="account"
          class="kv-list"
        >
          <div
            v-if="account.accountType"
            class="kv-row"
          >
            <span class="kv-key">Plan</span>
            <span class="kv-value">{{ account.accountType }}</span>
          </div>
          <div
            v-if="resetDate"
            class="kv-row"
          >
            <span class="kv-key">Reset Date</span>
            <span class="kv-value">{{ resetDate }}</span>
          </div>
        </div>
        <div
          v-else
          class="card-empty"
        >
          No account info
        </div>
      </DataCard>

      <!-- Quota Progress Bars -->
      <DataCard title="Quota">
        <div
          v-if="quotaItems.length > 0"
          class="quota-list"
        >
          <div
            v-for="item in quotaItems"
            :key="item.label"
            class="quota-item"
          >
            <div class="quota-header">
              <span class="quota-label">{{ item.label }}</span>
              <span class="quota-numbers">{{ formatNumber(item.used) }} / {{ formatNumber(item.limit) }}</span>
            </div>
            <ProgressBar
              :value="item.used"
              :max="item.limit"
            />
          </div>
        </div>
        <div
          v-else
          class="card-empty"
        >
          No quota data available
        </div>
      </DataCard>

      <!-- Session Token Totals -->
      <DataCard title="Session Tokens">
        <div
          v-if="sessionTokens"
          class="kv-list"
        >
          <div class="kv-row">
            <span class="kv-key">Input Tokens</span>
            <span class="kv-value mono">{{ formatNumber(sessionTokens.input) }}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">Output Tokens</span>
            <span class="kv-value mono">{{ formatNumber(sessionTokens.output) }}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">Total</span>
            <span class="kv-value mono">{{ formatNumber(sessionTokens.input + sessionTokens.output) }}</span>
          </div>
        </div>
        <div
          v-else
          class="card-empty"
        >
          No session data
        </div>
      </DataCard>

      <!-- Model Distribution -->
      <DataCard title="Model Distribution">
        <HorizontalBar
          v-if="Object.keys(modelDistribution).length > 0"
          :data="modelDistribution"
        />
        <div
          v-else
          class="card-empty"
        >
          No model data
        </div>
      </DataCard>
    </div>
  </div>
</template>

<style scoped>
.usage-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow-y: auto;
}

.usage-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-sm) var(--spacing-lg);
  border-bottom: 1px solid var(--border-light);
  flex-shrink: 0;
}

.usage-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text);
}

.usage-content {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: var(--spacing-lg);
  padding: var(--spacing-lg);
}

.kv-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.kv-row {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-sm);
}

.kv-key {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  min-width: 100px;
  flex-shrink: 0;
}

.kv-value {
  font-size: var(--font-size-xs);
  color: var(--text);
}

.kv-value.mono {
  font-family: var(--font-mono);
}

.card-empty {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  padding: var(--spacing-sm) 0;
}

.quota-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.quota-item {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.quota-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.quota-label {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.quota-numbers {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  font-family: var(--font-mono);
}

@media (max-width: 768px) {
  .usage-content {
    grid-template-columns: 1fr;
  }
}
</style>
