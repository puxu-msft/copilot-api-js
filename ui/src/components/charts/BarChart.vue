<script setup lang="ts">
import { computed } from "vue"

const props = withDefaults(
  defineProps<{
    data: Array<{ label: string; value: number }>
    maxBars?: number
  }>(),
  {
    maxBars: 12,
  },
)

/** Trimmed data and max value for scaling */
const chartData = computed(() => {
  const items = props.data.slice(0, props.maxBars)
  const maxVal = Math.max(...items.map((d) => d.value), 1)
  return { items, maxVal }
})
</script>

<template>
  <div class="bar-chart">
    <div class="bars">
      <div
        v-for="item in chartData.items"
        :key="item.label"
        class="bar-column"
      >
        <div class="bar-value">{{ item.value }}</div>
        <div class="bar-track">
          <div
            class="bar-fill"
            :style="{ height: (item.value / chartData.maxVal) * 100 + '%' }"
          />
        </div>
        <div class="bar-label">{{ item.label }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bar-chart {
  width: 100%;
  overflow-x: auto;
}

.bars {
  display: flex;
  gap: var(--spacing-xs);
  align-items: flex-end;
  min-height: 100px;
}

.bar-column {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  flex: 1;
  min-width: 24px;
}

.bar-value {
  font-size: 10px;
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.bar-track {
  width: 100%;
  height: 80px;
  display: flex;
  align-items: flex-end;
}

.bar-fill {
  width: 100%;
  background: var(--primary);
  min-height: 2px;
  transition: height var(--transition-normal);
}

.bar-label {
  font-size: 9px;
  color: var(--text-dim);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 60px;
}
</style>
