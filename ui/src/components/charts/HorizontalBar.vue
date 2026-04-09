<script setup lang="ts">
import { computed } from "vue"

const props = defineProps<{
  data: Record<string, number>
}>()

interface BarItem {
  label: string
  count: number
  percent: number
}

const items = computed<Array<BarItem>>(() => {
  const entries = Object.entries(props.data)
  if (entries.length === 0) return []
  const total = entries.reduce((sum, [, v]) => sum + v, 0)
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({
      label,
      count,
      percent: total > 0 ? (count / total) * 100 : 0,
    }))
})
</script>

<template>
  <div class="horizontal-bars">
    <div
      v-for="item in items"
      :key="item.label"
      class="hbar-row"
    >
      <span class="hbar-label">{{ item.label }}</span>
      <div class="hbar-track">
        <div
          class="hbar-fill"
          :style="{ width: item.percent + '%' }"
        />
      </div>
      <span class="hbar-count">{{ item.count }}</span>
    </div>
  </div>
</template>

<style scoped>
.horizontal-bars {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.hbar-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.hbar-label {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  min-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
  font-family: var(--font-mono);
}

.hbar-track {
  flex: 1;
  height: 8px;
  background: var(--bg-tertiary);
  overflow: hidden;
}

.hbar-fill {
  height: 100%;
  background: var(--primary);
  min-width: 2px;
  transition: width var(--transition-normal);
}

.hbar-count {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  font-family: var(--font-mono);
  min-width: 30px;
  text-align: right;
  flex-shrink: 0;
}
</style>
