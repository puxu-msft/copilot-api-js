<script setup lang="ts">
import { inject, ref, computed, watch, nextTick } from 'vue'
import type { HistoryStore } from '@/composables/useHistoryStore'
import type { ContentBlock, MessageContent } from '@/types'
import { isToolResultBlock, isToolUseBlock } from '@/utils/typeGuards'
import { provideContentContext } from '@/composables/useContentContext'
import { useRewriteInfo } from '@/composables/useRewriteInfo'
import DetailToolbar from './DetailToolbar.vue'
import SectionBlock from './SectionBlock.vue'
import MetaInfo from './MetaInfo.vue'
import TruncationDivider from './TruncationDivider.vue'
import SystemMessage from '@/components/message/SystemMessage.vue'
import MessageBlock from '@/components/message/MessageBlock.vue'
import RawJsonModal from '@/components/ui/RawJsonModal.vue'

const store = inject<HistoryStore>('historyStore')!
const showRawModal = ref(false)
const detailBodyRef = ref<HTMLElement>()

const entry = computed(() => store.selectedEntry.value)

// Rewrite info composable
const { truncationPoint, getRewrittenMessage, isMessageRewritten, isMessageTruncated } = useRewriteInfo(entry)

// Merged tool maps — single pass over messages
const toolMaps = computed(() => {
  const resultMap: Record<string, ContentBlock> = {}
  const nameMap: Record<string, string> = {}
  if (!entry.value) return { resultMap, nameMap }
  for (const msg of entry.value.request.messages) {
    if (typeof msg.content === 'string' || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (isToolResultBlock(block)) resultMap[block.tool_use_id] = block
      if (isToolUseBlock(block)) nameMap[block.id] = block.name
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

// Filter messages by role
const filteredMessages = computed(() => {
  if (!entry.value) return []
  let messages = entry.value.request.messages
  if (store.detailFilterRole.value) {
    messages = messages.filter(m => m.role === store.detailFilterRole.value)
  }
  return messages
})

// Response message
const responseMessage = computed<MessageContent | null>(() => {
  if (!entry.value?.response?.content) return null
  return entry.value.response.content
})

const requestBadge = computed(() => {
  if (!entry.value) return ''
  return `${entry.value.request.messages.length} messages`
})

function hasMatchingBlockType(msg: MessageContent, filterType: string): boolean {
  if (typeof msg.content === 'string') return filterType === 'text'
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

// Get original index for filtered messages
function getOriginalIndex(msg: MessageContent): number {
  if (!entry.value) return 0
  return entry.value.request.messages.indexOf(msg)
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
      <DetailToolbar @show-raw="showRawModal = true" />

      <div ref="detailBodyRef" class="detail-body">
        <!-- REQUEST Section -->
        <SectionBlock title="Request" :badge="requestBadge" :raw-data="entry.request" raw-title="Raw — Request">
          <!-- System prompt -->
          <SystemMessage
            v-if="entry.request.system"
            :system="entry.request.system"
            :rewritten-system="entry.rewrites?.rewrittenSystem"
            :search-query="store.detailSearch.value"
          />

          <!-- Messages with inline truncation divider -->
          <div class="messages-list">
            <template v-for="(msg, fi) in filteredMessages" :key="fi">
              <!-- Truncation divider: render after the last truncated message -->
              <TruncationDivider
                v-if="entry.rewrites?.truncation && getOriginalIndex(msg) === truncationPoint"
                :truncation="entry.rewrites.truncation"
              />

              <MessageBlock
                v-show="!store.detailFilterType.value || hasMatchingBlockType(msg, store.detailFilterType.value)"
                :message="msg"
                :index="getOriginalIndex(msg)"
                :is-truncated="isMessageTruncated(getOriginalIndex(msg))"
                :is-rewritten="isMessageRewritten(getOriginalIndex(msg))"
                :rewritten-message="getRewrittenMessage(getOriginalIndex(msg))"
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

        <!-- META Section -->
        <SectionBlock title="Meta" :raw-data="entry" raw-title="Raw — Full Entry">
          <MetaInfo :entry="entry" />
        </SectionBlock>
      </div>
    </template>

    <!-- Global Raw JSON Modal -->
    <RawJsonModal
      :visible="showRawModal"
      title="Raw — Full Entry"
      :data="entry"
      @update:visible="showRawModal = $event"
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
