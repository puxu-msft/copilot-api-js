<script setup lang="ts">
import { computed } from "vue"

interface TimelineBar {
  timestamp: number
  count: number
}

const props = withDefaults(
  defineProps<{
    data: Array<TimelineBar>
    height?: number
    showAxis?: boolean
    color?: string
  }>(),
  {
    height: 88,
    showAxis: true,
    color: "",
  },
)

const maxValue = computed(() => Math.max(...props.data.map((item) => item.count), 1))

const bars = computed(() =>
  props.data.map((item, index) => ({
    ...item,
    index,
    height: item.count > 0 ? Math.max((item.count / maxValue.value) * props.height, 2) : 1,
  })),
)

const tickLabels = computed(() => {
  if (props.data.length === 0) return []
  const tickIndexes = [0, 504, 1008, 1512, props.data.length - 1]
  return tickIndexes
    .filter((index, position, list) => index >= 0 && index < props.data.length && list.indexOf(index) === position)
    .map((index) => ({
      index,
      label: formatTickLabel(props.data[index].timestamp),
    }))
})

function formatTickLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hour = String(date.getHours()).padStart(2, "0")
  return `${month}/${day} ${hour}:00`
}
</script>

<template>
  <div class="timeline-chart">
    <div
      v-if="data.length > 0"
      class="timeline-bars"
      :style="{ height: `${height}px` }"
    >
      <div
        v-for="bar in bars"
        :key="bar.timestamp"
        class="timeline-bar"
        :title="`${formatTickLabel(bar.timestamp)} · ${bar.count}`"
      >
        <div
        class="timeline-bar-fill"
          :style="{ height: `${bar.height}px`, background: color || undefined }"
        />
      </div>
    </div>

    <div
      v-if="showAxis && tickLabels.length > 0"
      class="timeline-axis"
    >
      <div
        v-for="tick in tickLabels"
        :key="tick.index"
        class="timeline-tick"
        :style="{ left: `${(tick.index / Math.max(data.length - 1, 1)) * 100}%` }"
      >
        <span class="timeline-tick-label">{{ tick.label }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.timeline-chart {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.timeline-bars {
  display: flex;
  align-items: end;
  gap: 1px;
}

.timeline-bar {
  flex: 1 1 0;
  display: flex;
  align-items: end;
  min-width: 0;
}

.timeline-bar-fill {
  width: 100%;
  border-radius: 999px 999px 0 0;
  background: linear-gradient(180deg, rgb(var(--v-theme-primary)), rgb(var(--v-theme-info)));
  opacity: 0.92;
}

.timeline-axis {
  position: relative;
  height: 16px;
}

.timeline-tick {
  position: absolute;
  transform: translateX(-50%);
}

.timeline-tick-label {
  font-size: 0.68rem;
  line-height: 1;
  color: rgb(var(--v-theme-secondary));
  white-space: nowrap;
}
</style>
