<script setup lang="ts">
import { computed } from "vue"

import type { ActiveRequestInfo } from "@/api/ws"
import type { EntrySummary } from "@/types"

import VHistoryDetailDialog from "@/components/detail/VHistoryDetailDialog.vue"
import { useDashboardStatus } from "@/composables/useDashboardStatus"
import { useFormatters } from "@/composables/useFormatters"
import { useHistoryDetailRoute } from "@/composables/useHistoryDetailRoute"
import { useLogs } from "@/composables/useLogs"
import { formatWsTargetStatus } from "@/utils/ws-status"

const { entries, loading, wsConnected } = useLogs()
const {
  activeRequests,
  requestStateColor,
  resolvedActiveCount,
  wsConnected: requestsWsConnected,
} = useDashboardStatus()
const { formatTime, formatNumber, formatDuration } = useFormatters()
const { detailOpen, detailLoading, detailMissingId, detailTitle, openHistoryDetail, closeHistoryDetail } =
  useHistoryDetailRoute()
const activityWsStatusLabel = computed(() => formatWsTargetStatus("activity feed", wsConnected.value))
const requestsWsStatusLabel = computed(() => formatWsTargetStatus("requests", requestsWsConnected.value))

function requestState(entry: EntrySummary): string {
  if (entry.state) return entry.state
  if (entry.responseSuccess === false) return "failed"
  if (entry.responseSuccess) return "completed"
  return "pending"
}

function statusIcon(entry: EntrySummary): string {
  const state = requestState(entry)
  if (state === "completed") return "mdi-check-circle"
  if (state === "failed") return "mdi-close-circle"
  if (state === "streaming") return "mdi-waveform"
  if (state === "executing") return "mdi-progress-clock"
  return "mdi-clock-outline"
}

function statusColor(entry: EntrySummary): string {
  const state = requestState(entry)
  if (state === "completed") return "success"
  if (state === "failed") return "error"
  if (state === "streaming") return "info"
  if (state === "executing") return "warning"
  return "secondary"
}

function modelName(entry: EntrySummary): string {
  return entry.responseModel || entry.requestModel || "-"
}

function endpointLabel(entry: EntrySummary): string {
  if (entry.rawPath) return entry.rawPath
  return entry.endpoint
    .replace(/^\/v\d+\//, "")
    .replaceAll("/", " ")
    .replaceAll("-", " ")
}

function tokenIn(entry: EntrySummary): string {
  if (!entry.usage) return "-"
  return formatNumber(entry.usage.input_tokens)
}

function tokenOut(entry: EntrySummary): string {
  if (!entry.usage) return "-"
  return formatNumber(entry.usage.output_tokens)
}

function cacheTokenInfo(entry: EntrySummary): string {
  if (!entry.usage) return "-"
  const read = entry.usage.cache_read_input_tokens ?? 0
  const written = entry.usage.cache_creation_input_tokens ?? 0
  if (read <= 0 && written <= 0) return "-"
  return `${formatNumber(read)}/${formatNumber(written)}`
}

function statusText(entry: EntrySummary): string {
  return requestState(entry)
}

function previewText(entry: EntrySummary): string {
  return entry.previewText || entry.responseError || "-"
}

function truncPreview(entry: EntrySummary): string {
  const text = previewText(entry)
  if (text.length <= 140) return text
  return text.slice(0, 137) + "..."
}

function shortSessionId(value?: string): string {
  if (!value) return "-"
  return value.slice(0, 8)
}

function shortRequestId(value: string): string {
  if (!value) return "-"
  return value.slice(0, 8)
}

function activeModel(request: ActiveRequestInfo): string {
  return request.model ?? "?"
}

const sortedEntries = computed(() => entries.value)
</script>

<template>
  <div class="activity-page v-page-root">
    <div class="v-page-scroll">
      <section class="activity-shell px-4 px-md-6 pt-4 pb-6">
        <div class="page-toolbar">
          <div class="toolbar-copy">
            <div class="toolbar-title">Activity</div>
            <div class="toolbar-meta text-caption text-medium-emphasis">
              {{ entries.length }} recent events · {{ resolvedActiveCount }} active upstream requests
            </div>
          </div>

          <div class="toolbar-status">
            <v-chip
              color="primary"
              size="small"
              variant="tonal"
            >
              {{ loading && entries.length === 0 ? "Loading" : "Activity feed" }}
            </v-chip>
            <v-chip
              :color="wsConnected ? 'success' : 'error'"
              size="small"
              variant="tonal"
            >
              {{ activityWsStatusLabel }}
            </v-chip>
            <v-chip
              :color="requestsWsConnected ? 'success' : 'error'"
              size="small"
              variant="tonal"
            >
              {{ requestsWsStatusLabel }}
            </v-chip>
          </div>
        </div>

        <v-sheet
          class="panel panel-active"
          color="surface"
          border
          data-testid="activity-realtime-panel"
        >
          <div class="panel-head">
            <div>
              <div class="panel-eyebrow text-caption text-medium-emphasis text-uppercase">Realtime</div>
              <div class="panel-title">Active Requests</div>
            </div>
            <div class="text-caption text-medium-emphasis">{{ resolvedActiveCount }} active</div>
          </div>

          <div
            v-if="activeRequests.length > 0"
            class="active-panel-body active-table-wrap"
            data-testid="activity-realtime-panel-body"
          >
            <v-table
              density="compact"
              fixed-header
              class="activity-table bg-transparent"
            >
              <thead>
                <tr>
                  <th class="table-head col-status"></th>
                  <th class="table-head">Model</th>
                  <th class="table-head">Endpoint</th>
                  <th class="table-head">State</th>
                  <th class="table-head">Strategy</th>
                  <th class="table-head text-right">Queue</th>
                  <th class="table-head text-right">Dur</th>
                  <th class="table-head text-right">Try</th>
                  <th class="table-head text-right col-action">Detail</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="request in activeRequests"
                  :key="request.id"
                >
                  <td class="col-status">
                    <v-icon
                      :color="requestStateColor(request.state)"
                      size="x-small"
                    >
                      mdi-circle
                    </v-icon>
                  </td>
                  <td class="font-mono dense-cell">{{ activeModel(request) }}</td>
                  <td class="dense-cell text-medium-emphasis">{{ request.rawPath ?? request.endpoint }}</td>
                  <td class="dense-cell">{{ request.state }}</td>
                  <td class="dense-cell text-medium-emphasis">{{ request.currentStrategy ?? "-" }}</td>
                  <td class="font-mono dense-cell text-right">{{ formatDuration(request.queueWaitMs) }}</td>
                  <td class="font-mono dense-cell text-right">{{ formatDuration(request.durationMs) }}</td>
                  <td class="font-mono dense-cell text-right">{{ request.attemptCount ?? 1 }}</td>
                  <td class="text-right">
                    <v-btn
                      variant="text"
                      size="x-small"
                      @click="openHistoryDetail(request.id)"
                    >
                      Details
                    </v-btn>
                  </td>
                </tr>
              </tbody>
            </v-table>
          </div>
          <div
            v-else
            class="active-panel-body empty-state"
            data-testid="activity-realtime-panel-body"
          >
            <div class="empty-title">No active requests right now.</div>
            <div class="text-caption text-medium-emphasis">New upstream executions will appear here in real time.</div>
          </div>
        </v-sheet>

        <v-sheet
          class="panel panel-log-stream"
          color="surface"
          border
        >
          <div class="panel-head">
            <div>
              <div class="panel-eyebrow text-caption text-medium-emphasis text-uppercase">Activities</div>
              <div class="panel-title">Recent Request Feed</div>
            </div>
            <div class="text-caption text-medium-emphasis">Latest {{ entries.length }} entries</div>
          </div>

          <div
            v-if="loading && entries.length === 0"
            class="state-shell"
          >
            <v-progress-circular
              indeterminate
              color="primary"
            />
          </div>

          <div
            v-else-if="entries.length === 0"
            class="state-shell"
          >
            <span class="text-medium-emphasis">No activity entries yet</span>
          </div>

          <div
            v-else
            class="stream-table-wrap"
          >
            <v-table
              density="compact"
              fixed-header
              hover
              class="stream-table bg-transparent"
            >
              <thead>
                <tr>
                  <th class="table-head col-status"></th>
                  <th class="table-head col-time">Time</th>
                  <th class="table-head col-endpoint">Endpoint</th>
                  <th class="table-head col-model">Model</th>
                  <th class="table-head col-state">State</th>
                  <th class="table-head text-right col-msgs">Msgs</th>
                  <th class="table-head text-right col-bool">Strm</th>
                  <th class="table-head text-right col-dur">Dur</th>
                  <th class="table-head text-right col-token">In</th>
                  <th class="table-head text-right col-token">Out</th>
                  <th class="table-head text-right col-cache">Cache</th>
                  <th class="table-head col-session">Session</th>
                  <th class="table-head col-preview">Preview</th>
                  <th class="table-head text-right col-action">Detail</th>
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
                  <td class="col-time font-mono dense-cell text-medium-emphasis">
                    {{ formatTime(entry.startedAt) }}
                  </td>
                  <td class="col-endpoint dense-cell text-medium-emphasis">
                    {{ endpointLabel(entry) }}
                  </td>
                  <td class="col-model font-mono dense-cell">
                    <span
                      class="truncate-inline"
                      :title="modelName(entry)"
                    >
                      {{ modelName(entry) }}
                    </span>
                  </td>
                  <td class="col-state dense-cell">
                    <span
                      class="status-pill"
                      :class="`status-pill-${statusText(entry)}`"
                    >
                      {{ statusText(entry) }}
                    </span>
                  </td>
                  <td class="font-mono dense-cell text-right col-msgs">{{ entry.messageCount }}</td>
                  <td class="font-mono dense-cell text-right col-bool">{{ entry.stream ? "y" : "-" }}</td>
                  <td class="font-mono dense-cell text-right col-dur">{{ formatDuration(entry.durationMs) }}</td>
                  <td class="font-mono dense-cell text-right col-token">{{ tokenIn(entry) }}</td>
                  <td class="font-mono dense-cell text-right col-token">{{ tokenOut(entry) }}</td>
                  <td class="font-mono dense-cell text-right col-cache">{{ cacheTokenInfo(entry) }}</td>
                  <td class="col-session font-mono dense-cell text-medium-emphasis">
                    <span :title="`${shortSessionId(entry.sessionId)} · ${shortRequestId(entry.id)}`">
                      {{ shortSessionId(entry.sessionId) }}/{{ shortRequestId(entry.id) }}
                    </span>
                  </td>
                  <td class="col-preview dense-cell">
                    <span
                      class="preview-text"
                      :title="previewText(entry)"
                    >
                      {{ truncPreview(entry) }}
                    </span>
                  </td>
                  <td class="text-right">
                    <v-btn
                      variant="text"
                      size="x-small"
                      @click="openHistoryDetail(entry.id)"
                    >
                      Details
                    </v-btn>
                  </td>
                </tr>
              </tbody>
            </v-table>
          </div>
        </v-sheet>
      </section>
    </div>

    <VHistoryDetailDialog
      :model-value="detailOpen"
      :title="detailTitle"
      :loading="detailLoading"
      :missing-id="detailMissingId"
      @update:model-value="(value) => !value && closeHistoryDetail()"
    />
  </div>
</template>

<style scoped>
.activity-shell {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page-toolbar,
.panel {
  border: 1px solid rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
}

.page-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
}

.toolbar-title {
  font-size: 1.125rem;
  line-height: 1.2;
  letter-spacing: -0.02em;
  font-weight: 700;
}

.toolbar-meta {
  margin-top: 4px;
}

.toolbar-status {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.panel {
  padding: 16px;
}

.panel-head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.panel-eyebrow,
.table-head {
  letter-spacing: 0.08em;
}

.panel-title {
  font-size: 1.02rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.active-table-wrap,
.stream-table-wrap {
  overflow-x: auto;
}

.active-panel-body {
  /*
   * Keep the realtime panel at a fixed height so the page layout does not jump
   * when active requests spike. With the current compact table density,
   * 244px shows roughly 5 request rows plus the table header.
   *
   * To reduce the default visible capacity to about 3 rows, lower this height
   * to roughly 170-180px and verify in the browser after any row-density changes.
   */
  height: 244px;
}

.active-table-wrap {
  overflow-y: auto;
}

.activity-table :deep(th),
.activity-table :deep(td),
.stream-table :deep(th),
.stream-table :deep(td) {
  padding-top: 6px;
  padding-bottom: 6px;
}

.stream-table :deep(th),
.stream-table :deep(td) {
  padding-left: 8px;
  padding-right: 8px;
}

.table-head {
  font-size: 0.68rem;
  text-transform: uppercase;
  color: rgb(var(--v-theme-secondary));
  white-space: nowrap;
}

.dense-cell {
  font-size: 0.76rem;
  line-height: 1.2;
  white-space: nowrap;
}

.col-status {
  width: 28px;
}

.col-time {
  width: 68px;
}

.col-endpoint {
  width: 92px;
}

.col-model {
  width: 200px;
  max-width: 200px;
}

.col-state {
  width: 70px;
}

.col-msgs,
.col-bool,
.col-dur,
.col-token,
.col-cache {
  width: 56px;
}

.col-action {
  width: 72px;
}

.col-session {
  width: 96px;
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

.status-pill {
  display: inline-flex;
  align-items: center;
  min-height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.status-pill-completed {
  background: rgb(var(--v-theme-success) / 14%);
  color: rgb(var(--v-theme-success));
}

.status-pill-failed {
  background: rgb(var(--v-theme-error) / 14%);
  color: rgb(var(--v-theme-error));
}

.status-pill-pending {
  background: rgb(var(--v-theme-secondary) / 14%);
  color: rgb(var(--v-theme-secondary));
}

.status-pill-executing {
  background: rgb(var(--v-theme-warning) / 14%);
  color: rgb(var(--v-theme-warning));
}

.status-pill-streaming {
  background: rgb(var(--v-theme-info) / 14%);
  color: rgb(var(--v-theme-info));
}

.state-shell,
.empty-state {
  min-height: 140px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.empty-state.active-panel-body {
  min-height: unset;
}

.empty-title {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 6px;
}

@media (max-width: 780px) {
  .page-toolbar,
  .detail-dialog-toolbar {
    flex-direction: column;
    align-items: start;
  }
}
</style>
