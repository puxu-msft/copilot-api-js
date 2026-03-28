<script setup lang="ts">
import { computed } from "vue"

import type { EntrySummary } from "@/types"

import { useFormatters } from "@/composables/useFormatters"
import { useLogs } from "@/composables/useLogs"

const { entries, loading, wsConnected } = useLogs()
const { formatTime, formatNumber, formatDuration } = useFormatters()

function statusIcon(entry: EntrySummary): string {
  if (entry.responseSuccess === undefined) return "mdi-clock-outline"
  return entry.responseSuccess ? "mdi-check-circle" : "mdi-close-circle"
}

function statusColor(entry: EntrySummary): string {
  if (entry.responseSuccess === undefined) return "secondary"
  return entry.responseSuccess ? "success" : "error"
}

function modelName(entry: EntrySummary): string {
  return entry.responseModel || entry.requestModel || "-"
}

function tokenIn(entry: EntrySummary): string {
  if (!entry.usage) return "-"
  return formatNumber(entry.usage.input_tokens)
}

function tokenOut(entry: EntrySummary): string {
  if (!entry.usage) return "-"
  return formatNumber(entry.usage.output_tokens)
}

function truncPreview(entry: EntrySummary): string {
  const text = entry.previewText || ""
  if (text.length <= 100) return text
  return text.slice(0, 97) + "..."
}

const sortedEntries = computed(() => entries.value)
</script>

<template>
  <div class="d-flex flex-column fill-height">
    <!-- Toolbar -->
    <div class="toolbar-bar d-flex align-center px-4 py-2 ga-3">
      <span class="text-body-2 font-weight-bold">Live Logs</span>
      <span class="text-caption text-medium-emphasis">{{ entries.length }} entries</span>
      <v-spacer />
      <v-chip
        :color="wsConnected ? 'success' : 'error'"
        size="x-small"
        variant="tonal"
      >
        {{ wsConnected ? "Live" : "Offline" }}
      </v-chip>
    </div>

    <!-- Loading state -->
    <div
      v-if="loading && entries.length === 0"
      class="d-flex align-center justify-center flex-grow-1"
    >
      <v-progress-circular
        indeterminate
        color="primary"
      />
    </div>

    <!-- Empty state -->
    <div
      v-else-if="entries.length === 0"
      class="d-flex align-center justify-center flex-grow-1"
    >
      <span class="text-medium-emphasis">No log entries yet</span>
    </div>

    <!-- Table -->
    <div
      v-else
      class="flex-grow-1 overflow-y-auto"
    >
      <v-table
        density="compact"
        fixed-header
        hover
        class="logs-table"
      >
        <thead>
          <tr>
            <th class="col-status"></th>
            <th class="col-time">Time</th>
            <th class="col-model">Model</th>
            <th class="col-duration text-right">Dur</th>
            <th class="col-tokens text-right">In</th>
            <th class="col-tokens text-right">Out</th>
            <th>Preview</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="entry in sortedEntries"
            :key="entry.id"
          >
            <td class="col-status">
              <v-icon
                :icon="statusIcon(entry)"
                :color="statusColor(entry)"
                size="x-small"
              />
            </td>
            <td class="col-time mono text-medium-emphasis">
              {{ formatTime(entry.timestamp) }}
            </td>
            <td class="col-model mono">
              <span
                class="model-text"
                :title="modelName(entry)"
                >{{ modelName(entry) }}</span
              >
            </td>
            <td class="col-duration mono text-right">
              {{ formatDuration(entry.durationMs) }}
            </td>
            <td class="col-tokens mono text-right">{{ tokenIn(entry) }}</td>
            <td class="col-tokens mono text-right">{{ tokenOut(entry) }}</td>
            <td class="col-preview">
              <span
                class="preview-text"
                :title="entry.previewText || ''"
                >{{ truncPreview(entry) }}</span
              >
            </td>
          </tr>
        </tbody>
      </v-table>
    </div>
  </div>
</template>

<style scoped>
.mono {
  font-family: "SF Mono", Monaco, "Courier New", monospace;
}

.toolbar-bar {
  background: rgb(var(--v-theme-surface));
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
  flex-shrink: 0;
}

.logs-table {
  background: transparent !important;
}

/* Compact row heights */
.logs-table :deep(td),
.logs-table :deep(th) {
  font-size: 12px !important;
  padding: 4px 8px !important;
  height: auto !important;
}

.logs-table :deep(th) {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: rgb(var(--v-theme-secondary));
}

.col-status {
  width: 28px;
  text-align: center;
}

.col-time {
  width: 72px;
  white-space: nowrap;
}

.col-model {
  width: 200px;
  max-width: 200px;
}

.model-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-duration {
  width: 60px;
  white-space: nowrap;
}

.col-tokens {
  width: 60px;
  white-space: nowrap;
}

.col-preview {
  max-width: 0;
}

.preview-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgb(var(--v-theme-secondary));
}
</style>
