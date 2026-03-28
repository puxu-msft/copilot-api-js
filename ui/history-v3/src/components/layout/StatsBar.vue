<script setup lang="ts">
import { computed } from "vue"

import { useFormatters } from "@/composables/useFormatters"
import { useInjectedHistoryStore } from "@/composables/useInjectedHistoryStore"

const store = useInjectedHistoryStore()
const { formatNumber, formatDuration } = useFormatters()

/** Cache hit rate: cache_read tokens / total input tokens */
const cacheHitRate = computed(() => {
  const stats = store.stats.value
  if (!stats || stats.totalInputTokens === 0) return null
  // Stats don't track cache tokens directly, so only show when available
  return null
})

void cacheHitRate.value
</script>

<template>
  <div
    class="stats-bar"
    v-if="store.stats.value"
  >
    <div class="stat-item">
      <span class="stat-value">{{ formatNumber(store.stats.value.totalRequests) }}</span>
      <span class="stat-label">Requests</span>
    </div>
    <div class="stat-item stat-success">
      <span class="stat-value">{{ formatNumber(store.stats.value.successfulRequests) }}</span>
      <span class="stat-label">Success</span>
    </div>
    <div class="stat-item stat-error">
      <span class="stat-value">{{ formatNumber(store.stats.value.failedRequests) }}</span>
      <span class="stat-label">Failed</span>
    </div>
    <div class="stat-item">
      <span class="stat-value">{{ formatNumber(store.stats.value.totalInputTokens) }}</span>
      <span class="stat-label">In Tokens</span>
    </div>
    <div class="stat-item">
      <span class="stat-value">{{ formatNumber(store.stats.value.totalOutputTokens) }}</span>
      <span class="stat-label">Out Tokens</span>
    </div>
    <div
      v-if="store.stats.value.averageDurationMs"
      class="stat-item"
    >
      <span class="stat-value">{{ formatDuration(store.stats.value.averageDurationMs) }}</span>
      <span class="stat-label">Avg Duration</span>
    </div>
  </div>
</template>

<style scoped>
.stats-bar {
  height: var(--stats-height);
  display: flex;
  align-items: center;
  gap: var(--spacing-lg);
  padding: 0 var(--spacing-lg);
  background: var(--bg);
  border-bottom: 1px solid var(--border-light);
  flex-shrink: 0;
  font-size: var(--font-size-xs);
}

.stat-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
}

.stat-value {
  font-weight: 600;
  color: var(--text);
  font-family: var(--font-mono);
}

.stat-label {
  color: var(--text-dim);
}

.stat-success .stat-value {
  color: var(--success);
}

.stat-error .stat-value {
  color: var(--error);
}

@media (max-width: 768px) {
  .stats-bar {
    flex-wrap: wrap;
    height: auto;
    padding: var(--spacing-xs) var(--spacing-md);
    gap: var(--spacing-sm) var(--spacing-md);
  }
}
</style>
