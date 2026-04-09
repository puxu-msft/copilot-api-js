<script setup lang="ts">
import { ref } from "vue"

import type { HistoryStats } from "@/types"

import BarChart from "@/components/charts/BarChart.vue"
import HorizontalBar from "@/components/charts/HorizontalBar.vue"

defineProps<{
  stats: HistoryStats
}>()

const collapsed = ref(true)
</script>

<template>
  <div class="stats-charts">
    <button
      class="toggle-btn"
      @click="collapsed = !collapsed"
    >
      {{ collapsed ? "Show Charts" : "Hide Charts" }}
    </button>

    <div
      v-if="!collapsed"
      class="charts-content"
    >
      <!-- Activity chart -->
      <div
        v-if="stats.recentActivity?.length"
        class="chart-section"
      >
        <div class="chart-title">Recent Activity</div>
        <BarChart :data="stats.recentActivity.map((a) => ({ label: a.hour, value: a.count }))" />
      </div>

      <!-- Model distribution -->
      <div
        v-if="Object.keys(stats.modelDistribution ?? {}).length > 0"
        class="chart-section"
      >
        <div class="chart-title">Model Distribution</div>
        <HorizontalBar :data="stats.modelDistribution" />
      </div>

      <!-- Endpoint distribution -->
      <div
        v-if="Object.keys(stats.endpointDistribution ?? {}).length > 0"
        class="chart-section"
      >
        <div class="chart-title">Endpoint Distribution</div>
        <HorizontalBar :data="stats.endpointDistribution" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.stats-charts {
  border-bottom: 1px solid var(--border-light);
}

.toggle-btn {
  font-size: var(--font-size-xs);
  color: var(--primary);
  padding: var(--spacing-xs) var(--spacing-lg);
  background: none;
  cursor: pointer;
  width: 100%;
  text-align: left;
}

.toggle-btn:hover {
  background: var(--bg-hover);
}

.charts-content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
  padding: var(--spacing-sm) var(--spacing-lg) var(--spacing-lg);
}

.chart-section {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.chart-title {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-muted);
}
</style>
