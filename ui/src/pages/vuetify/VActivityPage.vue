<script setup lang="ts">
import { computed } from "vue"
import { useRouter } from "vue-router"

import type { EntrySummary } from "@/types"

import { useDashboardStatus } from "@/composables/useDashboardStatus"
import { useHistoryStore } from "@/composables/useHistoryStore"
import {
  endpointLabel,
  modelName,
  requestState,
  statusColor,
  statusIcon,
  tokenIn,
  tokenOut,
  truncPreview,
} from "@/utils/activity-helpers"
import { formatDuration, formatTime } from "@/utils/formatters"

const router = useRouter()
const store = useHistoryStore()
const { activeRequests, requestStateColor } = useDashboardStatus()

const endpointOptions = [
  { title: "Anthropic Messages", value: "anthropic-messages" },
  { title: "OpenAI Chat Completions", value: "openai-chat-completions" },
  { title: "OpenAI Responses", value: "openai-responses" },
]

const statusOptions = [
  { title: "Success", value: "true" },
  { title: "Failed", value: "false" },
]

/** Merge active requests (as synthetic EntrySummary) with history entries */
const mergedEntries = computed<Array<{ entry: EntrySummary; isActive: boolean }>>(() => {
  const historyIds = new Set(store.entries.map((e) => e.id))

  // Active requests not yet in history, filtered by current endpoint/status selection
  const activeRows = activeRequests.value
    .filter((req) => !historyIds.has(req.id))
    .filter((req) => !store.filterEndpoint || req.endpoint === store.filterEndpoint)
    .filter(() => store.filterSuccess == null)
    .map((req) => ({
      entry: {
        id: req.id,
        startedAt: req.startTime,
        endpoint: req.endpoint as EntrySummary["endpoint"],
        rawPath: req.rawPath,
        state: req.state as EntrySummary["state"],
        active: true,
        requestModel: req.model,
        stream: req.stream,
        messageCount: 0,
        durationMs: req.durationMs,
        attemptCount: req.attemptCount,
        currentStrategy: req.currentStrategy,
        queueWaitMs: req.queueWaitMs,
        previewText: "",
        searchText: "",
      } satisfies EntrySummary,
      isActive: true,
    }))

  const historyRows = store.entries.map((entry) => ({
    entry,
    isActive: entry.active === true || (entry.state != null && entry.state !== "completed" && entry.state !== "failed"),
  }))

  return [...activeRows, ...historyRows]
})

function openDetail(id: string): void {
  void router.push(`/activity/${id}`)
}

function onEndpointFilter(value: string | null): void {
  store.setEndpointFilter(value)
}

function onStatusFilter(value: string | null): void {
  store.setSuccessFilter(value)
}
</script>

<template>
  <div class="activity-page v-page-root">
    <div class="v-page-scroll">
      <section class="activity-shell px-4 px-md-6 pt-4 pb-6">
        <!-- Toolbar -->
        <div class="page-toolbar">
          <div class="toolbar-copy">
            <div class="toolbar-title">Activity</div>
            <div class="toolbar-meta text-caption text-medium-emphasis">
              {{ store.total }} total · {{ mergedEntries.filter((r) => r.isActive).length }} active
            </div>
          </div>

          <div class="toolbar-controls">
            <v-select
              :model-value="store.filterEndpoint"
              :items="endpointOptions"
              placeholder="Endpoint"
              clearable
              style="max-width: 220px"
              @update:model-value="onEndpointFilter"
            />
            <v-select
              :model-value="store.filterSuccess"
              :items="statusOptions"
              placeholder="Status"
              clearable
              style="max-width: 140px"
              @update:model-value="onStatusFilter"
            />
          </div>
        </div>

        <!-- Request table -->
        <v-sheet
          class="panel"
          color="surface"
          border
        >
          <div
            v-if="store.loading && store.entries.length === 0"
            class="state-shell"
          >
            <v-progress-circular
              indeterminate
              color="primary"
            />
          </div>

          <div
            v-else-if="store.error"
            class="state-shell"
          >
            <v-icon
              icon="mdi-alert-circle-outline"
              size="36"
              color="error"
              class="mb-2"
            />
            <span class="text-medium-emphasis">{{ store.error }}</span>
          </div>

          <div
            v-else-if="mergedEntries.length === 0"
            class="state-shell"
          >
            <span class="text-medium-emphasis">No activity entries yet</span>
          </div>

          <div
            v-else
            class="table-wrap"
          >
            <v-table
              density="compact"
              fixed-header
              hover
              class="activity-table bg-transparent"
            >
              <thead>
                <tr>
                  <th class="table-head col-status"></th>
                  <th class="table-head col-time">Time</th>
                  <th class="table-head col-model">Model</th>
                  <th class="table-head col-endpoint">Endpoint</th>
                  <th class="table-head col-state">State</th>
                  <th class="table-head text-right col-dur">Dur</th>
                  <th class="table-head text-right col-token">In</th>
                  <th class="table-head text-right col-token">Out</th>
                  <th class="table-head col-preview">Preview</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="{ entry, isActive } in mergedEntries"
                  :key="entry.id"
                  :class="{ 'active-row': isActive }"
                  class="clickable-row"
                  @click="openDetail(entry.id)"
                >
                  <td class="col-status">
                    <v-icon
                      :icon="statusIcon(entry)"
                      :color="isActive ? requestStateColor(requestState(entry)) : statusColor(entry)"
                      size="x-small"
                    />
                  </td>
                  <td class="col-time font-mono dense-cell text-medium-emphasis">
                    {{ formatTime(entry.startedAt) }}
                  </td>
                  <td class="col-model font-mono dense-cell">
                    <span
                      class="truncate-inline"
                      :title="modelName(entry)"
                    >
                      {{ modelName(entry) }}
                    </span>
                  </td>
                  <td class="col-endpoint dense-cell text-medium-emphasis">
                    {{ endpointLabel(entry) }}
                  </td>
                  <td class="col-state dense-cell">
                    <span
                      class="status-pill"
                      :class="`status-pill-${requestState(entry)}`"
                    >
                      {{ requestState(entry) }}
                    </span>
                  </td>
                  <td class="font-mono dense-cell text-right col-dur">
                    {{ formatDuration(entry.durationMs) }}
                  </td>
                  <td class="font-mono dense-cell text-right col-token">
                    {{ tokenIn(entry) }}
                  </td>
                  <td class="font-mono dense-cell text-right col-token">
                    {{ tokenOut(entry) }}
                  </td>
                  <td class="col-preview dense-cell">
                    <span
                      class="preview-text"
                      :title="entry.previewText || entry.responseError || undefined"
                    >
                      {{ truncPreview(entry) }}
                    </span>
                  </td>
                </tr>
              </tbody>
            </v-table>
          </div>

          <!-- Pagination -->
          <div
            v-if="store.total > 0"
            class="pagination-bar"
          >
            <v-btn
              variant="text"
              size="small"
              :disabled="!store.prevCursor"
              @click="store.loadPrev()"
            >
              <v-icon icon="mdi-chevron-left" />
              Newer
            </v-btn>
            <span class="text-caption text-medium-emphasis font-mono">
              {{ store.entries.length }} of {{ store.total }}
            </span>
            <v-btn
              variant="text"
              size="small"
              :disabled="!store.nextCursor"
              @click="store.loadNext()"
            >
              Older
              <v-icon icon="mdi-chevron-right" />
            </v-btn>
          </div>
        </v-sheet>
      </section>
    </div>
  </div>
</template>

<style scoped>
.activity-shell {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
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

.toolbar-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.panel {
  padding: 0;
  border-color: rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
}

.table-wrap {
  overflow-x: auto;
}

.activity-table :deep(th),
.activity-table :deep(td) {
  padding-top: 6px;
  padding-bottom: 6px;
  padding-left: 8px;
  padding-right: 8px;
}

.table-head {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgb(var(--v-theme-secondary));
  white-space: nowrap;
}

.dense-cell {
  font-size: 0.76rem;
  line-height: 1.2;
  white-space: nowrap;
}

.clickable-row {
  cursor: pointer;
}

.active-row {
  background: rgb(var(--v-theme-primary) / 6%);
}

.col-status { width: 28px; }
.col-time { width: 68px; }
.col-model { width: 200px; max-width: 200px; }
.col-endpoint { width: 92px; }
.col-state { width: 80px; }
.col-dur, .col-token { width: 56px; }
.col-preview { max-width: 0; }

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
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.status-pill-completed { background: rgb(var(--v-theme-success) / 14%); color: rgb(var(--v-theme-success)); }
.status-pill-failed { background: rgb(var(--v-theme-error) / 14%); color: rgb(var(--v-theme-error)); }
.status-pill-pending { background: rgb(var(--v-theme-secondary) / 14%); color: rgb(var(--v-theme-secondary)); }
.status-pill-executing { background: rgb(var(--v-theme-warning) / 14%); color: rgb(var(--v-theme-warning)); }
.status-pill-streaming { background: rgb(var(--v-theme-info) / 14%); color: rgb(var(--v-theme-info)); }

.pagination-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 8px 16px;
  border-top: 1px solid rgb(var(--v-theme-surface-variant));
}

.state-shell {
  min-height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
}

@media (max-width: 780px) {
  .page-toolbar {
    flex-direction: column;
    align-items: start;
  }

  .toolbar-controls {
    flex-wrap: wrap;
  }
}
</style>
