<script setup lang="ts">
/** @deprecated Use VLogsPage.vue (`/v/logs`) for ongoing UI work. */
import { computed } from "vue"

import type { EntrySummary } from "@/types"

import { useFormatters } from "@/composables/useFormatters"
import { useLogs } from "@/composables/useLogs"

const { entries, loading } = useLogs()
const { formatTime, formatNumber, formatDuration } = useFormatters()

function statusIndicator(entry: EntrySummary): string {
  if (entry.responseSuccess === undefined) return "pending"
  return entry.responseSuccess ? "success" : "error"
}

function statusSymbol(entry: EntrySummary): string {
  if (entry.responseSuccess === undefined) return "-"
  return entry.responseSuccess ? "ok" : "err"
}

function httpStatusCode(entry: EntrySummary): string {
  // No HTTP status on summary — show based on success
  if (entry.responseSuccess === undefined) return "..."
  return entry.responseSuccess ? "200" : "ERR"
}

function modelName(entry: EntrySummary): string {
  return entry.responseModel || entry.requestModel || "-"
}

function tokenInfo(entry: EntrySummary): string {
  if (!entry.usage) return "-"
  return `${formatNumber(entry.usage.input_tokens)}/${formatNumber(entry.usage.output_tokens)}`
}

/** Truncate preview text to fit compact view */
function truncPreview(entry: EntrySummary): string {
  const text = entry.previewText || ""
  if (text.length <= 60) return text
  return text.slice(0, 57) + "..."
}

const sortedEntries = computed(() => {
  // Already sorted by timestamp descending from API
  return entries.value
})
</script>

<template>
  <div class="logs-page">
    <div class="logs-header">
      <h2 class="logs-title">Live Logs</h2>
      <span class="logs-count">{{ entries.length }} entries</span>
    </div>

    <div
      v-if="loading && entries.length === 0"
      class="logs-empty"
    >
      Loading...
    </div>

    <div
      v-else-if="entries.length === 0"
      class="logs-empty"
    >
      No log entries yet
    </div>

    <div
      v-else
      class="logs-table-wrap"
    >
      <table class="logs-table">
        <thead>
          <tr>
            <th class="col-status">St</th>
            <th class="col-time">Time</th>
            <th class="col-code">Code</th>
            <th class="col-model">Model</th>
            <th class="col-duration">Dur</th>
            <th class="col-tokens">In/Out</th>
            <th class="col-preview">Preview</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="entry in sortedEntries"
            :key="entry.id"
            class="log-row"
            :class="'row-' + statusIndicator(entry)"
          >
            <td class="col-status">
              <span
                class="status-symbol"
                :class="'st-' + statusIndicator(entry)"
              >
                {{ statusSymbol(entry) }}
              </span>
            </td>
            <td class="col-time">{{ formatTime(entry.timestamp) }}</td>
            <td class="col-code">{{ httpStatusCode(entry) }}</td>
            <td class="col-model">{{ modelName(entry) }}</td>
            <td class="col-duration">{{ formatDuration(entry.durationMs) }}</td>
            <td class="col-tokens">{{ tokenInfo(entry) }}</td>
            <td class="col-preview">{{ truncPreview(entry) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.logs-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.logs-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-sm) var(--spacing-lg);
  border-bottom: 1px solid var(--border-light);
  flex-shrink: 0;
}

.logs-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text);
}

.logs-count {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
}

.logs-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  color: var(--text-dim);
  font-size: var(--font-size-sm);
}

.logs-table-wrap {
  flex: 1;
  overflow-y: auto;
}

.logs-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
}

.logs-table th {
  position: sticky;
  top: 0;
  background: var(--bg-secondary);
  color: var(--text-dim);
  font-weight: 600;
  text-align: left;
  padding: var(--spacing-xs) var(--spacing-sm);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

.logs-table td {
  padding: 3px var(--spacing-sm);
  white-space: nowrap;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-light);
}

.log-row:hover {
  background: var(--bg-hover);
}

.col-status {
  width: 30px;
  text-align: center;
}

.col-time {
  width: 70px;
}

.col-code {
  width: 40px;
}

.col-model {
  width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.col-duration {
  width: 60px;
  text-align: right;
}

.col-tokens {
  width: 90px;
  text-align: right;
}

.col-preview {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 0;
}

.status-symbol {
  font-weight: 600;
}

.st-success {
  color: var(--success);
}

.st-error {
  color: var(--error);
}

.st-pending {
  color: var(--warning);
}

.row-error td {
  color: var(--error);
  opacity: 0.8;
}
</style>
