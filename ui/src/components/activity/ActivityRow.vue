<script setup lang="ts">
import { computed } from "vue"

import type { EntrySummary } from "@/types"

import {
  //
  endpointLabel,
  failureSummary,
  modelName,
  requestState,
  rowAnomaly,
  statusColor,
  statusIcon,
  statusLabel,
  tokenCacheRead,
  tokenIn,
  tokenOut,
  truncPreview,
} from "@/utils/activity-helpers"
import {
  //
  formatDuration,
  formatTime,
} from "@/utils/formatters"

const props = defineProps<{ entry: EntrySummary; selected?: boolean }>()
const emit = defineEmits<{ open: [id: string] }>()

// Non-completed rows surface structured failure attribution instead of preview,
// so most diagnosis happens in the list without opening the detail page.
const isCompleted = computed(() => requestState(props.entry) === "completed")
const detailText = computed(() => (isCompleted.value ? truncPreview(props.entry) : failureSummary(props.entry)))
const anomaly = computed(() => rowAnomaly(props.entry))
</script>

<template>
  <tr
    class="activity-row clickable-row"
    :class="{ 'is-selected': selected, 'is-active': entry.active }"
    @click="emit('open', entry.id)"
  >
    <td class="col-status">
      <v-icon
        :icon="statusIcon(entry)"
        :color="statusColor(entry)"
        size="x-small"
      />
    </td>
    <td class="col-time font-mono dense-cell text-medium-emphasis">{{ formatTime(entry.startedAt) }}</td>
    <td class="col-model font-mono dense-cell">
      <span
        class="truncate-inline"
        :title="modelName(entry)"
        >{{ modelName(entry) }}</span
      >
    </td>
    <td class="col-endpoint dense-cell text-medium-emphasis">{{ endpointLabel(entry) }}</td>
    <td class="col-state dense-cell">
      <v-chip
        :color="statusColor(entry)"
        size="x-small"
        variant="tonal"
        label
        >{{ statusLabel(entry) }}</v-chip
      >
    </td>
    <td
      class="font-mono dense-cell text-right col-dur"
      :class="{ 'anomaly-text': anomaly.slow }"
    >
      {{ formatDuration(entry.durationMs) }}
    </td>
    <td class="font-mono dense-cell text-right col-token">{{ tokenIn(entry) }}</td>
    <td class="font-mono dense-cell text-right col-token">{{ tokenOut(entry) }}</td>
    <td
      class="font-mono dense-cell text-right col-token"
      :class="{ 'anomaly-text': anomaly.cacheMiss }"
      :title="anomaly.cacheMiss ? 'No prompt-cache hit on a large request' : undefined"
    >
      {{ tokenCacheRead(entry) }}
    </td>
    <td class="col-preview dense-cell">
      <span
        class="preview-text"
        :class="{ 'preview-failure': !isCompleted }"
        :title="detailText || undefined"
        >{{ detailText }}</span
      >
    </td>
  </tr>
</template>

<style scoped>
.activity-row td {
  padding: 6px 8px;
}

.dense-cell {
  font-size: 0.76rem;
  line-height: 1.2;
  white-space: nowrap;
}

.clickable-row {
  cursor: pointer;
}

.is-active {
  background: rgb(var(--v-theme-primary) / 6%);
}

.is-selected {
  background: rgb(var(--v-theme-primary) / 12%);
}

.col-status {
  width: 28px;
}
.col-time {
  width: 68px;
}
.col-model {
  width: 200px;
  max-width: 200px;
}
.col-endpoint {
  width: 92px;
}
.col-state {
  width: 96px;
}
.col-dur,
.col-token {
  width: 56px;
}
.col-preview {
  max-width: 0;
}

.truncate-inline,
.preview-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-text {
  color: rgb(var(--v-theme-secondary));
}

.preview-failure {
  color: rgb(var(--v-theme-error));
}

.anomaly-text {
  color: rgb(var(--v-theme-warning));
  font-weight: 700;
}
</style>
