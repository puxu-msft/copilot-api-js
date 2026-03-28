<script setup lang="ts">
import { ref, watch } from "vue"

import type { EntrySummary } from "@/types"

import DetailPanel from "@/components/detail/DetailPanel.vue"
import ErrorBoundary from "@/components/ui/ErrorBoundary.vue"
import { useFormatters } from "@/composables/useFormatters"
import { getStatusClass } from "@/composables/useHistoryStore"
import { useInjectedHistoryStore } from "@/composables/useInjectedHistoryStore"

const store = useInjectedHistoryStore()
const { formatDate, formatNumber, formatDuration } = useFormatters()

// Search with debounce
const localSearch = ref("")
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(localSearch, (val) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    store.setSearch(val)
  }, 300)
})

// Filter options
const endpointOptions = [
  { title: "Anthropic Messages", value: "anthropic-messages" },
  { title: "OpenAI Chat Completions", value: "openai-chat-completions" },
  { title: "OpenAI Responses", value: "openai-responses" },
]

const statusOptions = [
  { title: "Success", value: "true" },
  { title: "Failed", value: "false" },
]

const endpointFilter = ref<string | null>(null)
const successFilter = ref<string | null>(null)

watch(endpointFilter, (val) => store.setEndpointFilter(val))
watch(successFilter, (val) => store.setSuccessFilter(val))

// Drawer visibility on mobile
const drawer = ref(true)

function statusIcon(entry: EntrySummary): string {
  const s = getStatusClass(entry)
  if (s === "success") return "mdi-check-circle"
  if (s === "error") return "mdi-close-circle"
  return "mdi-clock-outline"
}

function statusColor(entry: EntrySummary): string {
  const s = getStatusClass(entry)
  if (s === "success") return "success"
  if (s === "error") return "error"
  return "secondary"
}

function endpointLabel(ep: string): string {
  if (ep === "anthropic-messages") return "anthropic"
  if (ep === "openai-responses") return "responses"
  if (ep === "openai-chat-completions") return "chat"
  return ep
}

function endpointColor(ep: string): string {
  if (ep === "anthropic-messages") return "purple"
  if (ep === "openai-responses") return "success"
  return "info"
}

function modelName(entry: EntrySummary): string {
  return entry.responseModel || entry.requestModel || "-"
}

function selectEntry(id: string): void {
  void store.selectEntry(id)
}
</script>

<template>
  <div class="d-flex fill-height">
    <!-- Left panel: request list as navigation drawer -->
    <v-navigation-drawer
      v-model="drawer"
      :width="380"
      permanent
      class="border-e"
    >
      <!-- Toolbar with search + filters -->
      <template #prepend>
        <div class="drawer-header px-3 py-2 d-flex align-center ga-2">
          <span class="text-body-2 font-weight-bold">History</span>
          <span class="text-caption text-medium-emphasis">{{ store.total.value }}</span>
          <v-spacer />
          <v-btn
            icon
            size="x-small"
            variant="text"
            @click="store.refresh()"
          >
            <v-icon size="small">mdi-refresh</v-icon>
            <v-tooltip
              activator="parent"
              location="top"
              >Refresh</v-tooltip
            >
          </v-btn>
        </div>
        <div class="px-3 pb-2 d-flex flex-column ga-2">
          <v-text-field
            v-model="localSearch"
            placeholder="Search..."
            prepend-inner-icon="mdi-magnify"
            clearable
          />
          <div class="d-flex ga-2">
            <v-select
              v-model="endpointFilter"
              :items="endpointOptions"
              placeholder="All endpoints"
              clearable
              class="flex-grow-1"
            />
            <v-select
              v-model="successFilter"
              :items="statusOptions"
              placeholder="Status"
              clearable
              style="max-width: 120px"
            />
          </div>
        </div>
      </template>

      <!-- Request list -->
      <v-list
        density="compact"
        class="pa-0 request-list"
      >
        <v-list-item
          v-for="entry in store.entries.value"
          :key="entry.id"
          :active="store.selectedEntry.value?.id === entry.id"
          @click="selectEntry(entry.id)"
          class="request-item px-3 py-1"
        >
          <!-- Row 1: status icon + timestamp + endpoint chip + tokens + duration -->
          <div class="d-flex align-center ga-2 mb-1">
            <v-icon
              :icon="statusIcon(entry)"
              :color="statusColor(entry)"
              size="x-small"
            />
            <span class="mono text-caption text-medium-emphasis">{{ formatDate(entry.timestamp) }}</span>
            <v-chip
              :color="endpointColor(entry.endpoint)"
              size="x-small"
              variant="tonal"
              class="flex-shrink-0"
            >
              {{ endpointLabel(entry.endpoint) }}
            </v-chip>
            <v-spacer />
            <span
              v-if="entry.durationMs"
              class="mono text-caption text-disabled flex-shrink-0"
            >
              {{ formatDuration(entry.durationMs) }}
            </span>
          </div>
          <!-- Row 2: model + token counts -->
          <div class="d-flex align-center ga-2">
            <span
              class="mono text-caption model-truncate"
              :title="modelName(entry)"
            >
              {{ modelName(entry) }}
            </span>
            <v-spacer />
            <span
              v-if="entry.usage"
              class="mono text-caption text-disabled flex-shrink-0"
            >
              {{ formatNumber(entry.usage.input_tokens) }}/{{ formatNumber(entry.usage.output_tokens) }}
            </span>
          </div>
          <!-- Row 3: preview text -->
          <div
            v-if="entry.previewText"
            class="text-caption text-disabled preview-truncate mt-1"
          >
            {{ entry.previewText }}
          </div>
        </v-list-item>

        <!-- Pagination controls -->
        <div
          v-if="store.prevCursor.value || store.nextCursor.value"
          class="d-flex justify-center pa-2 ga-2"
        >
          <v-btn
            size="small"
            variant="outlined"
            :disabled="!store.prevCursor.value"
            @click="store.loadPrev()"
          >
            <v-icon start>mdi-chevron-left</v-icon>
            Newer
          </v-btn>
          <v-btn
            size="small"
            variant="outlined"
            :disabled="!store.nextCursor.value"
            @click="store.loadNext()"
          >
            Older
            <v-icon end>mdi-chevron-right</v-icon>
          </v-btn>
        </div>
      </v-list>
    </v-navigation-drawer>

    <!-- Right panel: detail view using existing DetailPanel -->
    <div class="flex-grow-1 d-flex flex-column overflow-hidden">
      <div
        v-if="!store.hasSelection.value"
        class="d-flex align-center justify-center fill-height"
      >
        <span class="text-medium-emphasis">Select a request to view details</span>
      </div>
      <ErrorBoundary
        v-else
        label="Detail panel"
      >
        <DetailPanel />
      </ErrorBoundary>
    </div>
  </div>
</template>

<style scoped>
.mono {
  font-family: "SF Mono", Monaco, "Courier New", monospace;
}

.drawer-header {
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

/* Ensure the navigation drawer content can scroll */
:deep(.v-navigation-drawer__content) {
  display: flex;
  flex-direction: column;
}

.request-list {
  overflow-y: auto;
  flex: 1;
}

.request-item {
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
  min-height: auto !important;
}

.request-item:hover {
  background: rgb(var(--v-theme-surface-variant));
}

.model-truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}

.preview-truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 340px;
}
</style>
