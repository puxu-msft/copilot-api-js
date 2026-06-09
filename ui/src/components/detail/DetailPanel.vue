<script setup lang="ts">
import {
  //
  ref,
  computed,
  watch,
  nextTick,
} from "vue"

import ErrorBoundary from "@/components/ui/ErrorBoundary.vue"
import RawJsonModal from "@/components/ui/RawJsonModal.vue"
import { provideContentContext } from "@/composables/useContentContext"
import { useDetailOrchestration } from "@/composables/useDetailOrchestration"
import { useDetailViewState } from "@/composables/useDetailViewState"
import { useHistoryStore } from "@/composables/useHistoryStore"
import { provideRawModal } from "@/composables/useRawModal"
import { downloadEntryAsJson } from "@/utils/export-entry"

import AttemptsTimeline from "./AttemptsTimeline.vue"
import DetailRequestSection from "./DetailRequestSection.vue"
import DetailResponseSection from "./DetailResponseSection.vue"
import DetailToolbar from "./DetailToolbar.vue"
import HeadersComparisonSection from "./HeadersComparisonSection.vue"
import MetaInfo from "./MetaInfo.vue"
import SectionBlock from "./SectionBlock.vue"
import SseEventsSection from "./SseEventsSection.vue"

const store = useHistoryStore()
const detail = useDetailViewState()
const detailBodyRef = ref<HTMLElement>()

const entry = computed(() => store.selectedEntry)

// Shared RawJsonModal — single instance for all child components
const { visible: rawModalVisible, data: rawModalData, rewrittenData: rawModalRewrittenData, title: rawModalTitle } = provideRawModal()

// Orchestration: tool maps, filtered messages, pipeline info, scroll helpers
const {
  truncationPoint,
  hasRewrites,
  rewriteSummary,
  rewrittenIndexList,
  getRewrittenMessage,
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

// Watch selectedEntry -> scroll detail body to bottom
watch(entry, (e) => {
  if (e) {
    void nextTick(() => {
      if (detailBodyRef.value) {
        detailBodyRef.value.scrollTo(0, detailBodyRef.value.scrollHeight)
      }
    })
  }
})

/** Export full entry as downloadable JSON file */
function exportEntry() {
  if (entry.value) downloadEntryAsJson(entry.value)
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

    <!-- Detail content -->
    <template v-else-if="entry">
      <DetailToolbar
        :has-rewrites="hasRewrites"
        :rewrite-summary="rewriteSummary"
        :rewritten-index-list="rewrittenIndexList"
        @export="exportEntry"
      />

      <div
        ref="detailBodyRef"
        class="detail-body"
      >
        <DetailRequestSection
          :entry="entry"
          :request-badge="requestBadge"
          :rewritten-request="rewrittenRequest"
          :filtered-messages="filteredMessages"
          :truncation-point="truncationPoint"
          :search-query="detail.detailSearch"
          :detail-filter-type="detail.detailFilterType"
          :detail-view-mode="detail.detailViewMode"
          :has-matching-block-type="hasMatchingBlockType"
          :is-message-truncated="isMessageTruncated"
          :is-message-rewritten="isMessageRewritten"
          :get-rewritten-message="getRewrittenMessage"
        />

        <DetailResponseSection
          :entry="entry"
          :response-message="responseMessage"
        />

        <!-- SSE EVENTS Section (only for streaming requests) -->
        <ErrorBoundary label="SSE events">
          <SseEventsSection
            v-if="entry.sseEvents?.length"
            :events="entry.sseEvents"
            title="SSE Events (upstream → proxy)"
          />
        </ErrorBoundary>

        <!-- Forwarded SSE Events (proxy → client) — compare against upstream above -->
        <ErrorBoundary label="Forwarded SSE events">
          <SseEventsSection
            v-if="entry.inboundResponse?.sseEvents?.length"
            :events="entry.inboundResponse.sseEvents"
            title="SSE Events (proxy → client)"
          />
        </ErrorBoundary>

        <!-- Forwarded content (proxy → client) for non-streaming — heterogeneous
             shape across endpoints, shown as raw JSON for an honest upstream-vs-client diff -->
        <ErrorBoundary label="Forwarded response">
          <SectionBlock
            v-if="entry.inboundResponse?.content != null"
            title="Forwarded Response (proxy → client)"
            :default-collapsed="true"
            :raw-data="entry.inboundResponse.content"
            raw-title="Forwarded Response"
          >
            <pre class="forwarded-content-json">{{ JSON.stringify(entry.inboundResponse.content, null, 2) }}</pre>
          </SectionBlock>
        </ErrorBoundary>

        <!-- HTTP HEADERS (unified comparison view) -->
        <HeadersComparisonSection
          v-if="entry.httpHeaders || (entry.outboundRequest as any)?.headers || (entry.outboundResponse as any)?.headers"
          :inbound-request="entry.httpHeaders?.inboundRequest"
          :outbound-request="entry.httpHeaders?.outboundRequest ?? (entry.outboundRequest as any)?.headers"
          :outbound-response="entry.httpHeaders?.outboundResponse ?? (entry.outboundResponse as any)?.headers"
        />

        <!-- ATTEMPTS TIMELINE (when multiple attempts) -->
        <SectionBlock
          v-if="entry.attempts && entry.attempts.length > 1"
          title="Retry Timeline"
          anchor="attempts"
        >
          <AttemptsTimeline :attempts="entry.attempts" />
        </SectionBlock>

        <!-- META Section -->
        <SectionBlock
          title="Meta"
          anchor="meta"
          :raw-data="entry"
          raw-title="Entry"
        >
          <ErrorBoundary label="Meta info">
            <MetaInfo :entry="entry" />
          </ErrorBoundary>
        </SectionBlock>
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

.forwarded-content-json {
  margin: 0;
  font-family: var(--font-mono, monospace);
  font-size: var(--font-size-xs);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
}
</style>
