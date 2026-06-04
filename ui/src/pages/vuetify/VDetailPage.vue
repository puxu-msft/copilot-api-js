<script setup lang="ts">
import {
computed,
watch,
shallowRef
} from "vue";
import {
useRoute,
useRouter
} from "vue-router";

import DetailPanel from "@/components/detail/DetailPanel.vue"
import TocTree from "@/components/detail/TocTree.vue"
import ErrorBoundary from "@/components/ui/ErrorBoundary.vue"
import { useHistoryStore } from "@/composables/useHistoryStore"
import { useTocTree } from "@/composables/useTocTree"
import { downloadEntryAsJson } from "@/utils/export-entry"
import {
formatDate,
formatDuration,
formatNumber
} from "@/utils/formatters";

const route = useRoute()
const router = useRouter()
const store = useHistoryStore()

const entryId = computed(() => {
  const id = route.params.id
  return typeof id === "string" ? id : ""
})

const entry = computed(() => store.selectedEntry)
const loading = shallowRef(false)
const loadError = shallowRef<string | null>(null)

const title = computed(() => {
  if (!entry.value) return "Loading..."
  return entry.value.response?.model || entry.value.request.model || "Request"
})

const subtitle = computed(() => {
  if (!entry.value) return entryId.value
  const parts: Array<string> = []
  if (entry.value.startedAt) parts.push(formatDate(entry.value.startedAt))
  if (entry.value.durationMs) parts.push(formatDuration(entry.value.durationMs))
  const usage = entry.value.response?.usage
  if (usage) {
    parts.push(`${formatNumber(usage.input_tokens)} in / ${formatNumber(usage.output_tokens)} out`)
  }
  return parts.join(" · ") || entryId.value
})

// ─── TOC tree ───
const { tocTree, activeId, expandedNodes, scrollTo, toggleNode } = useTocTree(entry)

/** Load entry when route param changes */
watch(
  entryId,
  async (id) => {
    if (!id) return
    if (store.selectedEntry?.id === id) return

    loading.value = true
    loadError.value = null
    try {
      await store.selectEntry(id)
      if (!store.selectedEntry || store.selectedEntry.id !== id) {
        loadError.value = "Request not found"
      }
    } catch (err) {
      loadError.value = err instanceof Error ? err.message : "Failed to load request"
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)

function goBack(): void {
  void router.push("/activity")
}

function exportEntry(): void {
  if (entry.value) downloadEntryAsJson(entry.value)
}
</script>

<template>
  <div class="detail-page v-page-root">
    <!-- Header bar -->
    <div class="detail-header">
      <v-btn
        variant="text"
        size="small"
        prepend-icon="mdi-arrow-left"
        @click="goBack"
      >
        Activity
      </v-btn>

      <div class="detail-heading">
        <div class="detail-title">{{ title }}</div>
        <div class="detail-subtitle text-caption text-medium-emphasis">
          {{ subtitle }}
        </div>
      </div>

      <v-spacer />

      <v-btn
        v-if="entry"
        variant="outlined"
        size="small"
        prepend-icon="mdi-download"
        @click="exportEntry"
      >
        Export
      </v-btn>
    </div>

    <!-- Content -->
    <div
      v-if="loading"
      class="state-shell"
    >
      <v-progress-circular
        indeterminate
        color="primary"
      />
    </div>

    <div
      v-else-if="loadError || !entry"
      class="state-shell"
    >
      <v-icon
        icon="mdi-alert-circle-outline"
        size="48"
        color="error"
        class="mb-3"
      />
      <div class="text-h6">{{ loadError || "Request not found" }}</div>
      <div class="text-caption text-medium-emphasis mt-2">ID: {{ entryId }}</div>
      <v-btn
        class="mt-4"
        variant="outlined"
        size="small"
        @click="goBack"
      >
        Back to Activity
      </v-btn>
    </div>

    <div
      v-else
      class="detail-layout"
    >
      <!-- TOC Sidebar -->
      <nav class="toc-sidebar">
        <div class="toc-title text-caption text-medium-emphasis text-uppercase">Outline</div>
        <TocTree
          :nodes="tocTree"
          :active-id="activeId"
          :expanded-nodes="expandedNodes"
          @navigate="scrollTo"
          @toggle="toggleNode"
        />
      </nav>

      <!-- Detail content -->
      <div class="detail-body">
        <ErrorBoundary label="Request detail">
          <DetailPanel />
        </ErrorBoundary>
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail-page {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.detail-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
  flex-shrink: 0;
}

.detail-heading {
  min-width: 0;
}

.detail-title {
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.2;
}

.detail-subtitle {
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ─── TOC Sidebar ─── */

.toc-sidebar {
  width: 260px;
  flex-shrink: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  border-right: 1px solid rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
  padding: 10px 0;
}

.toc-title {
  padding: 0 12px 8px;
  letter-spacing: 0.08em;
  font-weight: 600;
}

/* ─── Detail body ─── */

.detail-body {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.detail-body :deep(.detail-panel) {
  flex: 1;
  min-height: 0;
  min-width: 0;
  height: auto;
}

.detail-body :deep(.detail-empty) {
  display: none;
}

.state-shell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 200px;
}

@media (max-width: 768px) {
  .toc-sidebar {
    display: none;
  }
}
</style>
