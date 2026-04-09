<script setup lang="ts">
import { computed } from "vue"

const props = withDefaults(
  defineProps<{
    value: number
    max: number
    label?: string
    color?: string
  }>(),
  {
    label: undefined,
    color: undefined,
  },
)

/** Percentage of value/max */
const percent = computed(() => {
  if (props.max <= 0) return 0
  return Math.min((props.value / props.max) * 100, 100)
})

/** Remaining percentage for auto-color */
const remaining = computed(() => 100 - percent.value)

/** Auto-color based on remaining %: green > 50%, yellow 20-50%, red < 20% */
const barColor = computed(() => {
  if (props.color) return props.color
  if (remaining.value > 50) return "var(--success)"
  if (remaining.value > 20) return "var(--warning)"
  return "var(--error)"
})
</script>

<template>
  <div class="progress-bar-wrap">
    <div class="progress-track">
      <div
        class="progress-fill"
        :style="{ width: percent + '%', background: barColor }"
      />
    </div>
    <span
      v-if="label"
      class="progress-label"
      >{{ label }}</span
    >
  </div>
</template>

<style scoped>
.progress-bar-wrap {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  width: 100%;
}

.progress-track {
  flex: 1;
  height: 8px;
  background: var(--bg-tertiary);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  transition: width var(--transition-normal);
}

.progress-label {
  font-size: 10px;
  color: var(--text-dim);
  flex-shrink: 0;
}
</style>
