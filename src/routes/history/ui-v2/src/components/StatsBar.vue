<script setup lang="ts">
import type { HistoryStats } from '@/types'
import { formatNumber } from '@/composables/useFormatters'

defineProps<{
  stats: HistoryStats | null
}>()
</script>

<template>
  <div class="stats-bar">
    <div class="stat">
      <span class="stat-value">{{ formatNumber(stats?.totalRequests) }}</span>
      <span class="stat-label">requests</span>
    </div>
    <div class="stat stat-success">
      <span class="stat-value">{{ formatNumber(stats?.successfulRequests) }}</span>
      <span class="stat-label">success</span>
    </div>
    <div class="stat stat-error">
      <span class="stat-value">{{ formatNumber(stats?.failedRequests) }}</span>
      <span class="stat-label">failed</span>
    </div>
    <div class="stat">
      <span class="stat-value">{{ formatNumber(stats?.totalInputTokens) }}</span>
      <span class="stat-label">in tokens</span>
    </div>
    <div class="stat">
      <span class="stat-value">{{ formatNumber(stats?.totalOutputTokens) }}</span>
      <span class="stat-label">out tokens</span>
    </div>
  </div>
</template>

<style scoped>
.stats-bar {
  display: flex;
  gap: 24px;
  padding: 8px 16px;
  background: var(--n-color-embedded);
  border-bottom: 1px solid var(--n-border-color);
  border-top: 1px solid var(--n-border-color);
}

.stat {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.stat-value {
  font-weight: 600;
}

.stat-label {
  color: var(--n-text-color-3);
}

.stat-success .stat-value {
  color: var(--n-success-color);
}

.stat-error .stat-value {
  color: var(--n-error-color);
}
</style>
