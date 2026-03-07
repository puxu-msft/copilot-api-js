<script setup lang="ts">
import { inject, ref, computed, watch, nextTick } from 'vue'
import type { HistoryStore } from '@/composables/useHistoryStore'
import type { ContentBlock, MessageContent } from '@/types'
import { isToolResultBlock, isToolUseBlock } from '@/utils/typeGuards'
import { provideContentContext } from '@/composables/useContentContext'
import { useRewriteInfo } from '@/composables/useRewriteInfo'
import { provideRawModal } from '@/composables/useRawModal'
import { provideSharedResizeObserver } from '@/composables/useSharedResizeObserver'
import DetailToolbar from './DetailToolbar.vue'
import SectionBlock from './SectionBlock.vue'
import SseEventsSection from './SseEventsSection.vue'
import MetaInfo from './MetaInfo.vue'
import TruncationDivider from './TruncationDivider.vue'
import SystemMessage from '@/components/message/SystemMessage.vue'
import MessageBlock from '@/components/message/MessageBlock.vue'
import RawJsonModal from '@/components/ui/RawJsonModal.vue'

const store = inject<HistoryStore>('historyStore')!
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
} = useRewriteInfo(entry)

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
    if (msg.role === 'tool' && msg.tool_call_id) {
      resultMap[msg.tool_call_id] = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
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
  if (!entry.value) return ''
  return `${(entry.value.request.messages ?? []).length} messages`
})

/** Rewritten request payload for the Raw modal (original request with rewritten messages/system) */
const rewrittenRequest = computed(() => {
  if (!entry.value?.rewrites) return undefined
  const rw = entry.value.rewrites
  // Only construct if there are actual rewrites
  if (!rw.rewrittenMessages && !rw.rewrittenSystem) return undefined
  return {
    ...entry.value.request,
    ...(rw.rewrittenMessages && { messages: rw.rewrittenMessages }),
    ...(rw.rewrittenSystem !== undefined && { system: rw.rewrittenSystem }),
  }
})

function hasMatchingBlockType(msg: MessageContent, filterType: string): boolean {
  if (typeof msg.content === 'string') {
    if (filterType === 'text') return true
    // OpenAI tool_calls on a text message
    if (filterType === 'tool_use' && msg.tool_calls?.length) return true
    return false
  }
  if (!Array.isArray(msg.content)) return false
  return msg.content.some(b => b.type === filterType)
}

// Scroll and highlight helpers
function highlightBlock(el: HTMLElement) {
  el.classList.remove('highlight-flash')
  void el.offsetWidth // force reflow
  el.classList.add('highlight-flash')
}

function scrollToResult(toolUseId: string) {
  const el = document.getElementById('tool-result-' + toolUseId)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    highlightBlock(el)
  }
}

function scrollToCall(toolUseId: string) {
  const el = document.getElementById('tool-use-' + toolUseId)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    highlightBlock(el)
  }
}

// Watch detailSearch → scroll to first match
watch(() => store.detailSearch.value, (q) => {
  if (!q) return
  nextTick(() => {
    setTimeout(() => {
      const first = document.querySelector('.search-highlight')
      if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 50)
  })
})

// Watch selectedEntry → scroll detail body to bottom
watch(entry, (e) => {
  if (e) {
    nextTick(() => {
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
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  // Filename: entry id + model (if available)
  const model = entry.value.request.model || 'unknown'
  a.download = `${entry.value.id}_${model}.json`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="detail-panel">
    <!-- Empty state -->
    <div v-if="!store.hasSelection.value" class="detail-empty">
      <p>Select a request to view details</p>
      <p class="detail-hint">Use ↑↓ or j/k to navigate, / to search</p>
    </div>

    <!-- Detail content -->
    <template v-else-if="entry">
      <DetailToolbar
        :has-rewrites="hasRewrites"
        :rewrite-summary="rewriteSummary"
        :rewritten-index-list="rewrittenIndexList"
        @export="exportEntry"
      />

      <div ref="detailBodyRef" class="detail-body">
        <!-- REQUEST Section -->
        <SectionBlock title="Request" :badge="requestBadge" :raw-data="entry.request" :rewritten-raw-data="rewrittenRequest" raw-title="Raw — Request">
          <!-- System prompt -->
          <SystemMessage
            v-if="entry.request.system"
            :system="entry.request.system"
            :rewritten-system="entry.rewrites?.rewrittenSystem"
            :search-query="store.detailSearch.value"
            :global-view-mode="store.detailViewMode.value"
          />

          <!-- Messages with inline truncation divider -->
          <div class="messages-list">
            <template v-for="item in filteredMessages" :key="item.originalIndex">
              <!-- Truncation divider: render after the last truncated message -->
              <TruncationDivider
                v-if="entry.rewrites?.truncation && item.originalIndex === truncationPoint"
                :truncation="entry.rewrites.truncation"
              />

              <MessageBlock
                v-show="!store.detailFilterType.value || hasMatchingBlockType(item.msg, store.detailFilterType.value)"
                :message="item.msg"
                :index="item.originalIndex"
                :is-truncated="isMessageTruncated(item.originalIndex)"
                :is-rewritten="isMessageRewritten(item.originalIndex)"
                :rewritten-message="getRewrittenMessage(item.originalIndex)"
                :global-view-mode="store.detailViewMode.value"
              />
            </template>
          </div>
        </SectionBlock>

        <!-- RESPONSE Section -->
        <SectionBlock v-if="responseMessage || entry.response?.error" title="Response" :badge="responseMessage ? '1 message' : ''" :raw-data="entry.response" raw-title="Raw — Response">
          <!-- Error block -->
          <div v-if="entry.response?.error" class="response-error">
            <span class="error-label">Error</span>
            <span class="error-text">{{ entry.response.error }}</span>
          </div>

          <MessageBlock
            v-if="responseMessage"
            :message="responseMessage"
            :index="0"
          />
        </SectionBlock>

        <!-- SSE EVENTS Section (only for streaming requests) -->
        <SseEventsSection v-if="entry.sseEvents?.length" :events="entry.sseEvents" />

        <!-- META Section -->
        <SectionBlock title="Meta" :raw-data="entry" raw-title="Raw — Full Entry">
          <MetaInfo :entry="entry" />
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
  overflow-y: auto;
  padding: var(--spacing-sm);
}

.messages-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.response-error {
  background: var(--error-muted);
  border: 1px solid var(--error);
  padding: var(--spacing-sm);
  margin-bottom: var(--spacing-sm);
  display: flex;
  align-items: baseline;
  gap: var(--spacing-sm);
}

.error-label {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--error);
  letter-spacing: 0.5px;
}

.error-text {
  font-size: var(--font-size-sm);
  color: var(--error);
  white-space: pre-wrap;
  word-wrap: break-word;
}
</style>
