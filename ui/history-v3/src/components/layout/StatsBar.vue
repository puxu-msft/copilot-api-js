<script setup lang="ts">
import { inject } from 'vue'
import type { HistoryStore } from '@/composables/useHistoryStore'
import { useFormatters } from '@/composables/useFormatters'

const store = inject<HistoryStore>('historyStore')!
const { formatNumber } = useFormatters()
</script>

<template>
  <div class="stats-bar" v-if="store.stats.value">
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
