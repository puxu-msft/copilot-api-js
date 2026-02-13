<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { NButton, NIcon, NTag } from 'naive-ui'
import { CodeSlashOutline, CopyOutline, ChevronDown, ChevronForward, ExpandOutline, ContractOutline } from '@vicons/ionicons5'
import type { ContentBlock } from '@/types'

const props = defineProps<{
  block: ContentBlock
  searchQuery?: string
  aggregateTools?: boolean
  toolResultMap?: Record<string, ContentBlock>
}>()

defineEmits<{
  showRaw: [{ title: string; data: unknown }]
}>()

const collapsed = ref(false)
const isExpanded = ref(false)
const contentBodyRef = ref<HTMLElement | null>(null)
const isOverflowing = ref(false)
let resizeObserver: ResizeObserver | null = null

const MAX_COLLAPSED_HEIGHT = 200

function checkOverflow() {
  const el = contentBodyRef.value
  if (!el) {
    isOverflowing.value = false
    return
  }
  isOverflowing.value = el.scrollHeight > MAX_COLLAPSED_HEIGHT
}

onMounted(() => {
  resizeObserver = new ResizeObserver(() => checkOverflow())
  if (contentBodyRef.value) {
    resizeObserver.observe(contentBodyRef.value)
  }
  nextTick(checkOverflow)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
})

watch(collapsed, (val) => {
  if (!val) {
    nextTick(() => {
      if (contentBodyRef.value && resizeObserver) {
        resizeObserver.disconnect()
        resizeObserver.observe(contentBodyRef.value)
      }
      checkOverflow()
    })
  }
})

const typeColors: Record<string, 'default' | 'info' | 'success' | 'warning' | 'error' | 'primary'> = {
  text: 'default',
  tool_use: 'info',
  tool_result: 'success',
  image: 'warning',
  thinking: 'warning'
}

// Short summary for collapsed state
const collapsedSummary = computed(() => {
  if (props.block.type === 'text') {
    const text = props.block.text || ''
    return text.length > 60 ? text.slice(0, 60) + '...' : text
  }
  if (props.block.type === 'thinking') {
    const text = props.block.thinking || ''
    return text.length > 60 ? text.slice(0, 60) + '...' : text
  }
  if (props.block.type === 'tool_use') {
    return props.block.name || ''
  }
  if (props.block.type === 'tool_result') {
    return 'for ' + (props.block.tool_use_id || '')
  }
  return props.block.type
})

const displayText = computed(() => {
  if (props.block.type === 'text') return props.block.text || ''
  if (props.block.type === 'thinking') return props.block.thinking || ''
  if (props.block.type === 'tool_result') {
    const content = props.block.content
    if (typeof content === 'string') return content
    return JSON.stringify(content, null, 2)
  }
  return ''
})

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

const highlightedText = computed(() => {
  const escaped = escapeHtml(displayText.value)
  if (!props.searchQuery) return escaped
  const regex = new RegExp(`(${props.searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  return escaped.replace(regex, '<mark class="search-highlight">$1</mark>')
})

const toolResult = computed(() => {
  if (props.block.type !== 'tool_use') return null
  if (!props.aggregateTools || !props.toolResultMap) return null
  return props.toolResultMap[props.block.id || '']
})

const copyText = async () => {
  await navigator.clipboard.writeText(displayText.value)
}

const highlightBlock = (el: HTMLElement) => {
  el.classList.remove('highlight-flash')
  void el.offsetWidth
  el.classList.add('highlight-flash')
}

const scrollToResult = (toolId: string) => {
  const el = document.getElementById(`result-${toolId}`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    highlightBlock(el)
  }
}

const scrollToToolUse = (toolId: string) => {
  const el = document.getElementById(`tool-${toolId}`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    highlightBlock(el)
  }
}

const toggleExpand = (e: Event) => {
  e.stopPropagation()
  isExpanded.value = !isExpanded.value
}
</script>

<template>
  <div
    class="content-block"
    :id="block.type === 'tool_use' ? `tool-${block.id}` : block.type === 'tool_result' ? `result-${block.tool_use_id}` : undefined"
  >
    <div class="content-header">
      <div class="content-header-left" @click="collapsed = !collapsed">
        <NIcon size="10" class="collapse-icon">
          <ChevronDown v-if="!collapsed" />
          <ChevronForward v-else />
        </NIcon>
        <NTag :type="typeColors[block.type] || 'default'" size="tiny" :bordered="false">
          {{ block.type.toUpperCase() }}
        </NTag>
        <span v-if="block.type === 'tool_use' && block.name" class="tool-name">
          {{ block.name }}
        </span>
        <span v-if="block.type === 'tool_use' && block.id" class="tool-id">
          {{ block.id }}
        </span>
        <span v-if="block.type === 'tool_result' && block.tool_use_id" class="tool-id">
          for {{ block.tool_use_id }}
        </span>
        <span v-if="collapsed" class="collapsed-summary">{{ collapsedSummary }}</span>
      </div>
      <div class="content-header-actions">
        <NButton
          v-if="isOverflowing && !collapsed"
          text
          size="tiny"
          @click="toggleExpand"
          class="action-btn"
        >
          <template #icon>
            <NIcon>
              <ContractOutline v-if="isExpanded" />
              <ExpandOutline v-else />
            </NIcon>
          </template>
          {{ isExpanded ? 'Collapse' : 'Expand' }}
        </NButton>
        <NButton text size="tiny" class="action-btn" @click.stop="copyText">
          <template #icon>
            <NIcon><CopyOutline /></NIcon>
          </template>
          Copy
        </NButton>
        <NButton text size="tiny" class="action-btn" @click.stop="$emit('showRaw', { title: block.type, data: block })">
          <template #icon>
            <NIcon><CodeSlashOutline /></NIcon>
          </template>
          Raw
        </NButton>
      </div>
    </div>

    <div
      v-if="!collapsed"
      ref="contentBodyRef"
      class="content-body"
      :class="{ 'content-body-collapsed': !isExpanded }"
    >
      <!-- Text content -->
      <template v-if="block.type === 'text' || block.type === 'thinking'">
        <div class="content-text" v-html="highlightedText" />
      </template>

      <!-- Tool Use -->
      <template v-else-if="block.type === 'tool_use'">
        <pre class="tool-input">{{ JSON.stringify(block.input, null, 2) }}</pre>

        <!-- Inline tool result if aggregating -->
        <div v-if="toolResult" class="tool-result-inline">
          <div class="tool-result-header">
            <span>RESULT</span>
            <NButton text size="tiny" class="action-btn" @click.stop="$emit('showRaw', { title: 'Tool Result', data: toolResult })">
              <template #icon>
                <NIcon><CodeSlashOutline /></NIcon>
              </template>
              Raw
            </NButton>
          </div>
          <div class="tool-result-body">
            {{ typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content, null, 2) }}
          </div>
        </div>

        <!-- Link to result if not aggregating but results exist in conversation -->
        <a v-else-if="aggregateTools === false && toolResultMap" class="tool-link" @click.stop="scrollToResult(block.id || '')">
          → Jump to result
        </a>
      </template>

      <!-- Tool Result (when not aggregated) -->
      <template v-else-if="block.type === 'tool_result'">
        <div class="content-text" v-html="highlightedText" />
        <a class="tool-link" @click.stop="scrollToToolUse(block.tool_use_id || '')">
          ← Jump to call
        </a>
      </template>

      <!-- Image -->
      <template v-else-if="block.type === 'image'">
        <div class="image-placeholder">
          [Image: {{ block.source?.media_type || 'unknown' }}]
        </div>
      </template>

      <!-- Generic/Unknown -->
      <template v-else>
        <pre class="generic-content">{{ JSON.stringify(block, null, 2) }}</pre>
      </template>
    </div>
  </div>
</template>

<style scoped>
.content-block {
  border: 1px solid color-mix(in srgb, var(--n-border-color) 100%, var(--n-text-color-3) 30%);
  border-radius: 4px;
  margin-bottom: 8px;
  overflow: hidden;
}

.content-block:last-child {
  margin-bottom: 0;
}

.content-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  background: var(--n-color-embedded);
  border-bottom: 1px solid var(--n-border-color);
  user-select: none;
}

.content-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  cursor: pointer;
  padding: 2px 4px;
  margin: -2px -4px;
  border-radius: 4px;
}

.content-header-left:hover {
  opacity: 0.8;
}

.collapse-icon {
  color: var(--n-text-color-3);
  flex-shrink: 0;
}

.collapsed-summary {
  font-size: 10px;
  color: var(--n-text-color-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.content-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.action-btn {
  font-size: 11px;
}

.tool-name {
  font-weight: 600;
  font-size: 12px;
  color: var(--n-info-color);
}

.tool-id {
  font-size: 10px;
  color: var(--n-text-color-3);
  font-family: 'SF Mono', Monaco, 'Courier New', monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.content-body {
  padding: 8px;
}

.content-body-collapsed {
  max-height: 200px;
  overflow-y: auto;
}

.content-text {
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-input {
  background: var(--n-color-embedded);
  border-radius: 4px;
  padding: 8px;
  font-family: 'SF Mono', Monaco, 'Courier New', monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

.tool-result-inline {
  margin-top: 8px;
  border: 1px dashed var(--n-success-color);
  border-radius: 4px;
  overflow: hidden;
}

.tool-result-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  background: var(--n-success-color-suppl);
  font-size: 10px;
  font-weight: 600;
  color: var(--n-success-color);
}

.tool-result-body {
  padding: 8px;
  font-family: 'SF Mono', Monaco, 'Courier New', monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--n-primary-color);
  font-size: 10px;
  cursor: pointer;
  margin-top: 6px;
}

.tool-link:hover {
  text-decoration: underline;
}

.image-placeholder {
  color: var(--n-text-color-3);
  font-size: 12px;
  font-style: italic;
}

.generic-content {
  font-family: 'SF Mono', Monaco, 'Courier New', monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

:deep(.search-highlight) {
  background: var(--n-warning-color);
  color: var(--n-base-color);
  padding: 0 2px;
  border-radius: 2px;
}

@keyframes highlight-flash {
  0% { background: rgba(88, 166, 255, 0.2); }
  100% { background: transparent; }
}

.content-block.highlight-flash {
  animation: highlight-flash 1.5s ease-out;
}
</style>
