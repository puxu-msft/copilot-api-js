<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue"

import type { ContentBlock, MessageContent } from "@/types"

import ErrorBoundary from "@/components/ui/ErrorBoundary.vue"
import RawJsonModal from "@/components/ui/RawJsonModal.vue"
import { provideContentContext } from "@/composables/useContentContext"
import { useInjectedHistoryStore } from "@/composables/useInjectedHistoryStore"
import { usePipelineInfo } from "@/composables/usePipelineInfo"
import { provideRawModal } from "@/composables/useRawModal"
import { provideSharedResizeObserver } from "@/composables/useSharedResizeObserver"
import { isToolResultBlock, isToolUseBlock } from "@/utils/typeGuards"

import AttemptsTimeline from "./AttemptsTimeline.vue"
import DetailRequestSection from "./DetailRequestSection.vue"
import DetailResponseSection from "./DetailResponseSection.vue"
import DetailToolbar from "./DetailToolbar.vue"
import HeadersSection from "./HeadersSection.vue"
import MetaInfo from "./MetaInfo.vue"
import SectionBlock from "./SectionBlock.vue"
import SseEventsSection from "./SseEventsSection.vue"

const store = useInjectedHistoryStore()
const detailBodyRef = ref<HTMLElement>()

const entry = computed(() => store.selectedEntry.value)

// Plan A: Shared RawJsonModal — single instance for all child components
const {
  visible: rawModalVisible,
  data: rawModalData,
  rewrittenData: rawModalRewrittenData,
  title: rawModalTitle,
} = provideRawModal()

// Plan C: Shared ResizeObserver — single instance for all child components
provideSharedResizeObserver()

// Rewrite info composable (Plan D: pre-computed maps, O(1) lookups)
const {
  truncationPoint,
  hasRewrites,
  rewriteSummary,
  rewrittenIndexList,
  getRewrittenMessage,
  isMessageRewritten,
  isMessageTruncated,
} = usePipelineInfo(entry)

// Merged tool maps — single pass over messages
const toolMaps = computed(() => {
  const resultMap: Record<string, ContentBlock> = {}
  const nameMap: Record<string, string> = {}
  if (!entry.value) return { resultMap, nameMap }
  for (const msg of entry.value.request.messages ?? []) {
    // Anthropic format: content is ContentBlock[]
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (isToolResultBlock(block)) resultMap[block.tool_use_id] = block
        if (isToolUseBlock(block)) nameMap[block.id] = block.name
      }
    }
    // OpenAI format: tool_calls on message
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        nameMap[tc.id] = tc.function.name
      }
    }
    // OpenAI format: tool response (role: "tool" with tool_call_id)
    if (msg.role === "tool" && msg.tool_call_id) {
      resultMap[msg.tool_call_id] = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      } as ContentBlock
    }
  }
  return { resultMap, nameMap }
})

// Provide ContentContext so all content blocks can inject
provideContentContext({
  searchQuery: computed(() => store.detailSearch.value),
  filterType: computed(() => store.detailFilterType.value),
  aggregateTools: computed(() => store.aggregateTools.value),
  toolResultMap: computed(() => toolMaps.value.resultMap),
  toolUseNameMap: computed(() => toolMaps.value.nameMap),
  scrollToResult,
  scrollToCall,
})

// Plan D: Filter messages by role, with pre-computed original indices (eliminates indexOf)
const filteredMessages = computed(() => {
  if (!entry.value) return []
  const messages = entry.value.request.messages ?? []
  let indexed = messages.map((msg, i) => ({ msg, originalIndex: i }))
  if (store.detailFilterRole.value) {
    indexed = indexed.filter(({ msg }) => msg.role === store.detailFilterRole.value)
  }
  // Show only rewritten messages filter
  if (store.showOnlyRewritten.value) {
    indexed = indexed.filter(({ originalIndex }) => isMessageRewritten(originalIndex))
  }
  return indexed
})

// Response message
const responseMessage = computed<MessageContent | null>(() => {
  if (!entry.value?.response?.content) return null
  return entry.value.response.content
})

const requestBadge = computed(() => {
  if (!entry.value) return ""
  return `${(entry.value.request.messages ?? []).length} messages`
})

/** Rewritten request payload for the Raw modal (effectiveRequest with rewritten messages/system) */
const rewrittenRequest = computed(() => {
  if (!entry.value?.effectiveRequest) return undefined
  const eff = entry.value.effectiveRequest
  // Only construct if there are actual rewrites
  if (!eff.messages && !eff.system) return undefined
  return {
    ...entry.value.request,
    ...(eff.messages && { messages: eff.messages }),
    ...(eff.system !== undefined && { system: eff.system }),
  }
})

function hasMatchingBlockType(msg: MessageContent, filterType: string): boolean {
  if (typeof msg.content === "string") {
    if (filterType === "text") return true
    // OpenAI tool_calls on a text message
    if (filterType === "tool_use" && msg.tool_calls?.length) return true
    return false
  }
  if (!Array.isArray(msg.content)) return false
  return msg.content.some((b) => b.type === filterType)
}

// Scroll and highlight helpers
function highlightBlock(el: HTMLElement) {
  el.classList.remove("highlight-flash")
  void el.offsetWidth // force reflow
  el.classList.add("highlight-flash")
}

function scrollToResult(toolUseId: string) {
  const el = document.querySelector<HTMLElement>(`#tool-result-${toolUseId}`)
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" })
    highlightBlock(el)
  }
}

function scrollToCall(toolUseId: string) {
  const el = document.querySelector<HTMLElement>(`#tool-use-${toolUseId}`)
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" })
    highlightBlock(el)
  }
}

// Watch detailSearch -> scroll to first match
watch(
  () => store.detailSearch.value,
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
  if (!entry.value) return
  const json = JSON.stringify(entry.value, null, 2)
  const blob = new Blob([json], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  // Filename: entry id + model (if available)
  const model = entry.value.request.model || "unknown"
  a.download = `${entry.value.id}_${model}.json`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="detail-panel">
    <!-- Empty state -->
    <div
      v-if="!store.hasSelection.value"
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
          :search-query="store.detailSearch.value"
          :detail-filter-type="store.detailFilterType.value"
          :detail-view-mode="store.detailViewMode.value"
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
          />
        </ErrorBoundary>

        <!-- WIRE REQUEST HEADERS (collapsible) -->
        <SectionBlock
          v-if="entry.wireRequest?.headers"
          title="Wire Request Headers"
          default-collapsed
        >
          <HeadersSection
            :headers="entry.wireRequest.headers"
            title="Outbound Headers"
          />
        </SectionBlock>

        <!-- RESPONSE HEADERS (collapsible) -->
        <SectionBlock
          v-if="entry.response?.headers"
          title="Response Headers"
          default-collapsed
        >
          <HeadersSection
            :headers="entry.response.headers"
            title="Upstream Response Headers"
          />
        </SectionBlock>

        <!-- ATTEMPTS TIMELINE (when multiple attempts) -->
        <SectionBlock
          v-if="entry.attempts && entry.attempts.length > 1"
          title="Retry Timeline"
        >
          <AttemptsTimeline :attempts="entry.attempts" />
        </SectionBlock>

        <!-- META Section -->
        <SectionBlock
          title="Meta"
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

.headers-section-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.headers-group {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.headers-group-title {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding-bottom: var(--spacing-xs);
  border-bottom: 1px solid var(--border);
}

.headers-grid {
  display: flex;
  flex-direction: column;
}

.header-row {
  display: flex;
  gap: var(--spacing-sm);
  padding: 2px 0;
  font-size: var(--font-size-xs);
  border-bottom: 1px solid var(--border-light);
}

.header-name {
  flex: 0 0 220px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  word-break: break-all;
}

.header-value {
  flex: 1;
  color: var(--text);
  font-family: var(--font-mono);
  word-break: break-all;
}
</style>
