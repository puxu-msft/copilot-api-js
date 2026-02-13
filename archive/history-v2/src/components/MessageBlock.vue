<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NIcon, NTag } from 'naive-ui'
import { CodeSlashOutline, CopyOutline, ChevronDown, ChevronForward } from '@vicons/ionicons5'
import type { ContentBlock, SystemBlock } from '@/types'
import ContentBlockItem from './ContentBlockItem.vue'

const props = defineProps<{
  role: 'user' | 'assistant' | 'system'
  content: string | ContentBlock[] | SystemBlock[]
  searchQuery?: string
  filterType?: string | null
  aggregateTools?: boolean
  toolResultMap?: Record<string, ContentBlock>
  truncated?: boolean
  rewritten?: boolean
}>()

defineEmits<{
  showRaw: [title: string, data: unknown]
}>()

const collapsed = ref(false)

const roleColors: Record<string, 'info' | 'success' | 'warning' | 'error' | 'default' | 'primary'> = {
  user: 'info',
  assistant: 'success',
  system: 'warning'
}

const contentBlocks = computed((): ContentBlock[] => {
  let raw = props.content

  // response.content may be a message object { role, content }, unwrap it
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'content' in raw) {
    raw = (raw as Record<string, unknown>).content as typeof props.content
  }

  if (typeof raw === 'string') {
    return [{ type: 'text', text: raw }]
  }

  // Handle system blocks which have different structure
  if (props.role === 'system' && Array.isArray(raw)) {
    const blocks = raw as SystemBlock[]
    return blocks.map(b => ({ type: 'text' as const, text: b.text || '' }))
  }

  return raw as ContentBlock[]
})

const filteredBlocks = computed((): ContentBlock[] => {
  let blocks = contentBlocks.value

  // Filter by type
  if (props.filterType) {
    blocks = blocks.filter(b => b.type === props.filterType)
  }

  // Skip tool_result if aggregating (they'll be shown with tool_use)
  if (props.aggregateTools) {
    blocks = blocks.filter(b => b.type !== 'tool_result')
  }

  return blocks
})

// Summary for collapsed state
const collapsedSummary = computed(() => {
  const blocks = contentBlocks.value
  if (blocks.length === 1 && blocks[0].type === 'text') {
    const text = blocks[0].text || ''
    return text.length > 80 ? text.slice(0, 80) + '...' : text
  }
  const types = blocks.map(b => b.type)
  const counts: Record<string, number> = {}
  for (const t of types) counts[t] = (counts[t] || 0) + 1
  return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')
})

// When aggregation removes all blocks (e.g. message was all tool_results),
// collect the tool_use_ids so we can show links to the aggregated location
const aggregatedToolIds = computed((): string[] => {
  if (!props.aggregateTools || filteredBlocks.value.length > 0) return []
  return contentBlocks.value
    .filter(b => b.type === 'tool_result' && b.tool_use_id)
    .map(b => b.tool_use_id as string)
})

const scrollToToolUse = (toolId: string) => {
  const el = document.getElementById(`tool-${toolId}`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.remove('highlight-flash')
    void el.offsetWidth
    el.classList.add('highlight-flash')
  }
}

const getTextContent = () => {
  if (typeof props.content === 'string') return props.content
  if (Array.isArray(props.content)) {
    return props.content.map((b: ContentBlock | SystemBlock) => {
      if ('text' in b) return b.text
      if ('thinking' in b) return b.thinking
      return JSON.stringify(b)
    }).join('\n')
  }
  return ''
}

const copyContent = async () => {
  const text = getTextContent()
  await navigator.clipboard.writeText(text)
}
</script>

<template>
  <div :class="['message-block', { truncated }]">
    <div class="message-header">
      <div class="message-header-left" @click="collapsed = !collapsed">
        <NIcon size="12" class="collapse-icon">
          <ChevronDown v-if="!collapsed" />
          <ChevronForward v-else />
        </NIcon>
        <NTag :type="roleColors[role]" size="small" :bordered="false">
          {{ role.toUpperCase() }}
        </NTag>
        <span v-if="truncated" class="rewrite-badge deleted">(deleted)</span>
        <span v-else-if="rewritten" class="rewrite-badge rewritten">(rewritten)</span>
        <span v-if="collapsed" class="collapsed-summary">{{ collapsedSummary }}</span>
      </div>
      <div class="message-header-actions">
        <NButton text size="tiny" class="action-btn" @click.stop="copyContent">
          <template #icon>
            <NIcon><CopyOutline /></NIcon>
          </template>
          Copy
        </NButton>
        <NButton text size="tiny" class="action-btn" @click.stop="$emit('showRaw', role, content)">
          <template #icon>
            <NIcon><CodeSlashOutline /></NIcon>
          </template>
          Raw
        </NButton>
      </div>
    </div>

    <div v-if="!collapsed" class="message-body">
      <!-- Aggregated away: show links to the tool_use where results were merged -->
      <div v-if="aggregatedToolIds.length > 0" class="aggregated-links">
        <span class="aggregated-label">Tool results aggregated to:</span>
        <a
          v-for="toolId in aggregatedToolIds"
          :key="toolId"
          class="aggregated-link"
          @click="scrollToToolUse(toolId)"
        >
          ← {{ toolId }}
        </a>
      </div>

      <ContentBlockItem
        v-for="(block, index) in filteredBlocks"
        :key="index"
        :block="block"
        :search-query="searchQuery"
        :aggregate-tools="aggregateTools"
        :tool-result-map="toolResultMap"
        @show-raw="$emit('showRaw', $event.title, $event.data)"
      />
    </div>
  </div>
</template>

<style scoped>
.message-block {
  border: 1px solid color-mix(in srgb, var(--n-border-color) 100%, var(--n-text-color-3) 30%);
  border-radius: 6px;
  margin-bottom: 10px;
  overflow: hidden;
}

.message-block:last-child {
  margin-bottom: 0;
}

.message-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--n-color-embedded);
  border-bottom: 1px solid var(--n-border-color);
  user-select: none;
}

.message-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  cursor: pointer;
  padding: 2px 6px;
  margin: -2px -6px;
  border-radius: 4px;
}

.message-header-left:hover {
  opacity: 0.8;
}

.collapse-icon {
  color: var(--n-text-color-3);
  flex-shrink: 0;
}

.collapsed-summary {
  font-size: 11px;
  color: var(--n-text-color-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message-header-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.action-btn {
  font-size: 11px;
}

.message-body {
  padding: 10px;
}

.aggregated-links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}

.aggregated-label {
  color: var(--n-text-color-3);
}

.aggregated-link {
  color: var(--n-primary-color);
  cursor: pointer;
  font-family: 'SF Mono', Monaco, 'Courier New', monospace;
  font-size: 10px;
}

.aggregated-link:hover {
  text-decoration: underline;
}

.message-block.truncated {
  opacity: 0.45;
}

.message-block.truncated .message-header {
  background: color-mix(in srgb, var(--n-error-color) 8%, var(--n-color-embedded) 92%);
}

.rewrite-badge {
  font-size: 10px;
  font-weight: 600;
}

.rewrite-badge.deleted {
  color: var(--n-error-color);
}

.rewrite-badge.rewritten {
  color: var(--n-warning-color);
}
</style>
