<script setup lang="ts">
import {
  //
  ref,
  computed,
  watch,
  nextTick,
} from "vue"

import type { MessageContent } from "@/types"

import DiffModal from "@/components/detail/DiffModal.vue"
import RawJsonModal from "@/components/ui/RawJsonModal.vue"
import { provideContentContext } from "@/composables/useContentContext"
import { useDetailOrchestration } from "@/composables/useDetailOrchestration"
import { useDetailViewState } from "@/composables/useDetailViewState"
import { useHistoryStore } from "@/composables/useHistoryStore"
import { provideMessageActions } from "@/composables/useMessageActions"
import { provideRawModal } from "@/composables/useRawModal"
import { downloadEntryAsZst } from "@/utils/export-entry"

import DetailToolbar from "./DetailToolbar.vue"
import StageAttempts from "./stages/StageAttempts.vue"
import StageEffective from "./stages/StageEffective.vue"
import StageForwarded from "./stages/StageForwarded.vue"
import StageInbound from "./stages/StageInbound.vue"
import StageMeta from "./stages/StageMeta.vue"
import StageUpstream from "./stages/StageUpstream.vue"
import StageWire from "./stages/StageWire.vue"

const store = useHistoryStore()
const detail = useDetailViewState()
const detailBodyRef = ref<HTMLElement>()

const entry = computed(() => store.selectedEntry)

// Active stage is owned (validated) by VDetailPage which renders StageTabs;
// here we only read it to route to the right stage component. Toolbar controls
// (search / filter) only apply to message-rendering stages.
const activeStage = computed(() => detail.activeStage)
const showToolbar = computed(() => activeStage.value === "inbound" || activeStage.value === "effective" || activeStage.value === "upstream")

// ── Rich diff modal + inbound↔effective jump (provided to MessageBlock) ──
const diffVisible = ref(false)
const diffOriginal = ref<MessageContent | null>(null)
const diffEffective = ref<MessageContent | null>(null)
const diffLabel = ref("")
provideMessageActions({
  openDiff: (original, effective, label) => {
    diffOriginal.value = original
    diffEffective.value = effective
    diffLabel.value = label
    diffVisible.value = true
  },
  jumpToCounterpart: (index) => {
    detail.activeStage = activeStage.value === "effective" ? "inbound" : "effective"
    void nextTick(() => {
      const el = document.querySelector(`#request\\.messages\\.${index}`)
      if (!el) return
      el.scrollIntoView({ behavior: "smooth", block: "start" })
      // Expand the target message if collapsed (MessageBlock listens for this).
      el.dispatchEvent(new CustomEvent("toc-navigate", { bubbles: false }))
    })
  },
})

// Shared RawJsonModal — single instance for all child components
const { visible: rawModalVisible, data: rawModalData, rewrittenData: rawModalRewrittenData, title: rawModalTitle } = provideRawModal()

// Orchestration: tool maps, filtered messages, pipeline info, scroll helpers
const {
  truncationPoint,
  hasRewrites,
  rewriteSummary,
  rewrittenIndexList,
  getRewrittenMessage,
  getSplitMessages,
  isMessageRewritten,
  isMessageTruncated,
  toolMaps,
  filteredMessages,
  responseMessage,
  requestBadge,
  rewrittenRequest,
  hasMatchingBlockType,
  scrollToResult,
  scrollToCall,
} = useDetailOrchestration(entry)

// Provide ContentContext so all content blocks can inject
provideContentContext({
  searchQuery: computed(() => detail.detailSearch),
  filterType: computed(() => detail.detailFilterType),
  aggregateTools: computed(() => detail.aggregateTools),
  toolResultMap: computed(() => toolMaps.value.resultMap),
  toolUseNameMap: computed(() => toolMaps.value.nameMap),
  scrollToResult,
  scrollToCall,
})

// Search/filter are scoped to the current stage: reset them when the stage
// changes so a query typed in one stage doesn't silently carry into another
// (and the toolbar only exists in message stages anyway).
watch(activeStage, () => {
  detail.detailSearch = ""
  detail.detailFilterType = ""
})

// Watch detailSearch -> scroll to first match
watch(
  () => detail.detailSearch,
  (q) => {
    if (!q) return
    void nextTick(() => {
      setTimeout(() => {
        const first = document.querySelector(".search-highlight")
        if (first) first.scrollIntoView({ behavior: "smooth", block: "center" })
      }, 50)
    })
  },
)

// Watch selectedEntry -> scroll detail body to TOP (request/error first). Prev:
// auto-scrolled to bottom, which buried the inbound request + error on open and
// on every prev/next navigation — the opposite of what diagnosis needs.
watch(entry, (e) => {
  if (e) {
    void nextTick(() => {
      detailBodyRef.value?.scrollTo(0, 0)
    })
  }
})

/** Export full entry as a downloadable zstd-compressed `.json.zst` file */
function exportEntry() {
  if (entry.value) void downloadEntryAsZst(entry.value)
}
</script>

<template>
  <div class="detail-panel">
    <!-- Empty state -->
    <div
      v-if="!store.hasSelection"
      class="detail-empty"
    >
      <p>Select a request to view details</p>
      <p class="detail-hint">Use up/down or j/k to navigate, / to search</p>
    </div>

    <!-- Detail content (DiagnosticSummary + StageTabs live at page level above) -->
    <template v-else-if="entry">
      <DetailToolbar
        v-if="showToolbar"
        :has-rewrites="hasRewrites"
        :rewrite-summary="rewriteSummary"
        :rewritten-index-list="rewrittenIndexList"
        @export="exportEntry"
      />

      <div
        ref="detailBodyRef"
        class="detail-body"
      >
        <!-- Active pipeline stage (selected via the page-level StageTabs). Each
             stage component groups its own facets (parsed blocks / SSE / HTTP). -->
        <StageInbound
          v-if="activeStage === 'inbound'"
          :entry="entry"
          :request-badge="requestBadge"
          :rewritten-request="rewrittenRequest"
          :filtered-messages="filteredMessages"
          :truncation-point="truncationPoint"
          :search-query="detail.detailSearch"
          :detail-filter-type="detail.detailFilterType"
          :has-matching-block-type="hasMatchingBlockType"
          :is-message-truncated="isMessageTruncated"
          :is-message-rewritten="isMessageRewritten"
          :get-rewritten-message="getRewrittenMessage"
        />
        <StageEffective
          v-else-if="activeStage === 'effective'"
          :entry="entry"
          :request-badge="requestBadge"
          :rewritten-request="rewrittenRequest"
          :filtered-messages="filteredMessages"
          :truncation-point="truncationPoint"
          :search-query="detail.detailSearch"
          :detail-filter-type="detail.detailFilterType"
          :has-matching-block-type="hasMatchingBlockType"
          :is-message-truncated="isMessageTruncated"
          :is-message-rewritten="isMessageRewritten"
          :get-rewritten-message="getRewrittenMessage"
          :get-split-messages="getSplitMessages"
        />
        <StageWire
          v-else-if="activeStage === 'wire'"
          :entry="entry"
        />
        <StageUpstream
          v-else-if="activeStage === 'upstream'"
          :entry="entry"
          :response-message="responseMessage"
        />
        <StageForwarded
          v-else-if="activeStage === 'forwarded'"
          :entry="entry"
        />
        <StageAttempts
          v-else-if="activeStage === 'attempts'"
          :entry="entry"
        />
        <StageMeta
          v-else-if="activeStage === 'meta'"
          :entry="entry"
        />
      </div>
    </template>

    <!-- Shared Raw JSON Modal (single instance for all child components) -->
    <RawJsonModal
      :visible="rawModalVisible"
      :title="rawModalTitle"
      :data="rawModalData"
      :rewritten-data="rawModalRewrittenData"
      @update:visible="rawModalVisible = $event"
    />

    <!-- Rich diff modal (original vs effective), opened from a message's "diff". -->
    <DiffModal
      :visible="diffVisible"
      :original="diffOriginal"
      :effective="diffEffective"
      :label="diffLabel"
      @update:visible="diffVisible = $event"
    />
  </div>
</template>

<style scoped>
.detail-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--bg);
}

.detail-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-dim);
  gap: var(--spacing-xs);
}

.detail-hint {
  font-size: var(--font-size-xs);
  opacity: 0.6;
}

.detail-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: var(--spacing-sm);
}
</style>
