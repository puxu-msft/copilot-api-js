<script setup lang="ts">
import { onKeyStroke } from "@vueuse/core"
import {
  //
  computed,
  watch,
  shallowRef,
} from "vue"
import {
  //
  useRoute,
  useRouter,
} from "vue-router"

import DetailPanel from "@/components/detail/DetailPanel.vue"
import DiagnosticSummary from "@/components/detail/DiagnosticSummary.vue"
import StageTabs from "@/components/detail/StageTabs.vue"
import TocTree from "@/components/detail/TocTree.vue"
import ErrorBoundary from "@/components/ui/ErrorBoundary.vue"
import { useDetailStages } from "@/composables/useDetailStages"
import { useDetailViewState } from "@/composables/useDetailViewState"
import { useHistoryStore } from "@/composables/useHistoryStore"
import { useTocTree } from "@/composables/useTocTree"
import { downloadEntryAsJson } from "@/utils/export-entry"
import {
  //
  formatDate,
  formatDuration,
  formatNumber,
} from "@/utils/formatters"

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
  return entry.value.outboundResponse?.model || entry.value.inboundRequest.model || "Request"
})

const subtitle = computed(() => {
  if (!entry.value) return entryId.value
  const parts: Array<string> = []
  if (entry.value.startedAt) parts.push(formatDate(entry.value.startedAt))
  if (entry.value.durationMs) parts.push(formatDuration(entry.value.durationMs))
  const usage = entry.value.outboundResponse?.usage
  if (usage) {
    parts.push(`${formatNumber(usage.input_tokens)} in / ${formatNumber(usage.output_tokens)} out`)
  }
  return parts.join(" · ") || entryId.value
})

// ─── TOC tree (scoped to the active pipeline stage) ───
const { tocTree, activeId, expandedNodes, scrollTo, toggleNode } = useTocTree(entry)
const detail = useDetailViewState()
const activeStage = computed({
  get: () => detail.activeStage,
  set: (v: string) => {
    detail.activeStage = v
  },
})
const { activeTocIds, stages } = useDetailStages(entry, activeStage, { manageActiveStage: true })
// Show only the active stage's outline nodes, in the stage's declared order
// (headers-before-messages), not the global tree's push order.
const stageTocTree = computed(() =>
  activeTocIds.value.map((id) => tocTree.value.find((n) => n.id === id)).filter((n): n is NonNullable<typeof n> => n !== undefined),
)

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

/**
 * Drill into this request's session sequence. Sets the sessionId filter on the
 * (singleton) store then navigates to Activity — the keep-alive'd list reacts to
 * the store filter change (no URL-hydration-on-nav needed), and the filters→URL
 * watch makes the result shareable.
 */
function viewSession(): void {
  const sid = entry.value?.sessionId
  if (!sid) return
  store.setFilter("sessionId", sid)
  void router.push("/activity")
}

// ── prev/next navigation within the loaded list (crosses page boundaries) ──
const entryIndex = computed(() => store.entries.findIndex((e) => e.id === entryId.value))
const positionLabel = computed(() => {
  const i = entryIndex.value
  return i >= 0 ? `${i + 1}/${store.total}` : ""
})
const canPrev = computed(() => entryIndex.value > 0 || (entryIndex.value === 0 && Boolean(store.prevCursor)))
const canNext = computed(
  () => (entryIndex.value >= 0 && entryIndex.value < store.entries.length - 1) || (entryIndex.value === store.entries.length - 1 && Boolean(store.nextCursor)),
)

// prev/next REPLACE the current history entry (not push): browsing siblings
// with j/k shouldn't bloat the back-stack — one Back from any sibling returns to
// the Activity list. Object location form lets the router encode the id param.
function goToEntry(id: string): void {
  void router.replace({ name: "activity-detail", params: { id } })
}

async function goAdjacent(dir: "next" | "prev"): Promise<void> {
  const i = entryIndex.value
  if (i === -1) return
  if (dir === "next") {
    if (i < store.entries.length - 1) {
      goToEntry(store.entries[i + 1].id)
      return
    }
    if (store.nextCursor) {
      await store.fetchEntries(store.nextCursor, "older")
      if (store.entries[0]) goToEntry(store.entries[0].id)
    }
  } else {
    if (i > 0) {
      goToEntry(store.entries[i - 1].id)
      return
    }
    if (store.prevCursor) {
      await store.fetchEntries(store.prevCursor, "newer")
      const last = store.entries.at(-1)
      if (last) goToEntry(last.id)
    }
  }
}

/** Ignore keyboard shortcuts while typing in an input/textarea. */
function isTyping(): boolean {
  const el = document.activeElement
  if (!el) return false
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable
}

onKeyStroke("j", () => {
  if (!isTyping()) void goAdjacent("next")
})
onKeyStroke("k", () => {
  if (!isTyping()) void goAdjacent("prev")
})
onKeyStroke("Escape", () => {
  if (!isTyping()) goBack()
})
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

      <div class="detail-nav">
        <v-btn
          variant="text"
          size="small"
          icon="mdi-chevron-up"
          :disabled="!canPrev"
          title="Newer (k)"
          @click="goAdjacent('prev')"
        />
        <span
          v-if="positionLabel"
          class="detail-position font-mono text-caption text-medium-emphasis"
          >{{ positionLabel }}</span
        >
        <v-btn
          variant="text"
          size="small"
          icon="mdi-chevron-down"
          :disabled="!canNext"
          title="Older (j)"
          @click="goAdjacent('next')"
        />
      </div>

      <v-btn
        v-if="entry"
        variant="outlined"
        size="small"
        prepend-icon="mdi-download"
        @click="exportEntry"
      >
        Export
      </v-btn>
      <v-btn
        v-if="entry?.sessionId"
        variant="text"
        size="small"
        prepend-icon="mdi-link-variant"
        title="Filter Activity to this session"
        @click="viewSession"
      >
        Session
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

    <!-- Loaded: page-level diagnostic band + stage filter, then outline | content -->
    <div
      v-else
      class="detail-loaded"
    >
      <DiagnosticSummary :entry="entry" />
      <StageTabs
        v-model:active="activeStage"
        :stages="stages"
      />

      <div class="detail-layout">
        <!-- TOC Sidebar (scoped to the active stage) -->
        <nav class="toc-sidebar">
          <div class="toc-title text-caption text-medium-emphasis text-uppercase">Outline</div>
          <TocTree
            :nodes="stageTocTree"
            :active-id="activeId"
            :expanded-nodes="expandedNodes"
            @navigate="scrollTo"
            @toggle="toggleNode"
          />
        </nav>

        <!-- Detail content (active stage) -->
        <div class="detail-body">
          <ErrorBoundary label="Request detail">
            <DetailPanel />
          </ErrorBoundary>
        </div>
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

.detail-nav {
  display: flex;
  align-items: center;
  gap: 2px;
}

.detail-position {
  min-width: 48px;
  text-align: center;
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

.detail-loaded {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 12px 16px 0;
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
