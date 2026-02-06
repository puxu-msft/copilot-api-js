<script setup lang="ts">
import { NInput, NSelect, NSpin, NPagination, NEmpty, NTag } from 'naive-ui'
import { ref, watch, nextTick } from 'vue'
import type { HistoryEntry } from '@/types'
import { formatDate, formatNumber, formatDuration } from '@/composables/useFormatters'

const props = defineProps<{
  entries: HistoryEntry[]
  loading: boolean
  selectedId?: string
  page: number
  totalPages: number
  total: number
  searchQuery: string
  filterEndpoint: string | null
  filterSuccess: boolean | null
}>()

const emit = defineEmits<{
  select: [id: string]
  pageChange: [page: number]
  search: [query: string]
  filterEndpoint: [endpoint: string | null]
  filterSuccess: [success: boolean | null]
}>()

const localSearch = ref(props.searchQuery)
let searchTimeout: ReturnType<typeof setTimeout>

const handleSearchInput = (value: string) => {
  localSearch.value = value
  clearTimeout(searchTimeout)
  searchTimeout = setTimeout(() => {
    emit('search', value)
  }, 300)
}

const endpointOptions = [
  { label: 'All Endpoints', value: '' },
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'OpenAI', value: 'openai' }
]

const successOptions = [
  { label: 'All Status', value: '' },
  { label: 'Success', value: 'true' },
  { label: 'Failed', value: 'false' }
]

const handleEndpointChange = (value: string) => {
  emit('filterEndpoint', value || null)
}

const handleSuccessChange = (value: string) => {
  if (value === '') emit('filterSuccess', null)
  else emit('filterSuccess', value === 'true')
}

const getPreviewText = (entry: HistoryEntry): string => {
  const messages = entry.request?.messages || []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user') {
      const content = msg.content
      if (typeof content === 'string') {
        return content.replace(/<[^>]+>/g, '').slice(0, 100)
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            return block.text.replace(/<[^>]+>/g, '').slice(0, 100)
          }
          if (block.type === 'tool_result') {
            return `[tool_result: ${(block.tool_use_id || '').slice(0, 8)}...]`
          }
        }
      }
    }
  }
  return ''
}

// Auto-scroll selected item into view (for keyboard navigation)
watch(() => props.selectedId, async (id) => {
  if (!id) return
  await nextTick()
  const el = document.querySelector('.request-item.selected') as HTMLElement
  el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
})
</script>

<template>
  <div class="request-list-panel">
    <div class="list-controls">
      <NInput
        class="search-input"
        :value="localSearch"
        placeholder="Search requests..."
        size="small"
        clearable
        @update:value="handleSearchInput"
      />
      <div class="filters">
        <NSelect
          :value="filterEndpoint || ''"
          :options="endpointOptions"
          size="small"
          @update:value="handleEndpointChange"
        />
        <NSelect
          :value="filterSuccess === null ? '' : String(filterSuccess)"
          :options="successOptions"
          size="small"
          @update:value="handleSuccessChange"
        />
      </div>
    </div>

    <div class="request-list">
      <NSpin :show="loading" size="small">
        <div v-if="entries.length === 0 && !loading" class="empty-state">
          <NEmpty description="No requests found" />
        </div>

        <div
          v-for="entry in entries"
          :key="entry.id"
          class="request-item"
          :class="{ selected: entry.id === selectedId }"
          @click="$emit('select', entry.id)"
        >
          <div class="request-header">
            <span
              class="status-dot"
              :class="!entry.response ? 'pending' : entry.response.success !== false ? 'success' : 'error'"
            />
            <span class="request-time">{{ formatDate(entry.timestamp) }}</span>
          </div>

          <div class="request-body">
            <span class="request-model">{{ entry.response?.model || entry.request?.model || 'unknown' }}</span>
            <NTag :type="entry.endpoint === 'anthropic' ? 'info' : 'warning'" size="small" :bordered="false">
              {{ entry.endpoint }}
            </NTag>
            <NTag v-if="entry.request?.stream" type="success" size="small" :bordered="false">
              stream
            </NTag>
          </div>

          <div class="request-meta">
            <span>↓{{ formatNumber(entry.response?.usage?.input_tokens) }}</span>
            <span>↑{{ formatNumber(entry.response?.usage?.output_tokens) }}</span>
            <span>{{ formatDuration(entry.durationMs) }}</span>
          </div>

          <div v-if="getPreviewText(entry)" class="request-preview">
            {{ getPreviewText(entry) }}
          </div>
        </div>
      </NSpin>
    </div>

    <div v-if="totalPages > 1" class="list-pagination">
      <NPagination
        :page="page"
        :page-count="totalPages"
        :page-slot="5"
        size="small"
        @update:page="$emit('pageChange', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.request-list-panel {
  width: 320px;
  min-width: 280px;
  max-width: 400px;
  border-right: 1px solid var(--n-border-color);
  display: flex;
  flex-direction: column;
  background: var(--n-color-embedded);
  flex-shrink: 0;
}

.list-controls {
  padding: 8px;
  border-bottom: 1px solid var(--n-border-color);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.filters {
  display: flex;
  gap: 6px;
}

.filters > * {
  flex: 1;
}

.request-list {
  flex: 1;
  overflow-y: auto;
}

.empty-state {
  padding: 40px 20px;
}

.request-item {
  padding: 10px 12px;
  border-bottom: 1px solid var(--n-border-color);
  cursor: pointer;
  transition: background 0.1s;
}

.request-item:hover {
  background: var(--n-color-embedded-popover);
}

.request-item.selected {
  background: var(--n-color-target);
  border-left: 3px solid var(--n-primary-color);
  padding-left: 9px;
}

.request-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot.success {
  background: var(--n-success-color);
}

.status-dot.error {
  background: var(--n-error-color);
}

.status-dot.pending {
  background: var(--n-warning-color);
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.request-time {
  font-size: 11px;
  color: var(--n-text-color-3);
}

.request-body {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-bottom: 4px;
}

.request-model {
  font-weight: 500;
  font-size: 12px;
}

.request-meta {
  display: flex;
  gap: 8px;
  font-size: 10px;
  color: var(--n-text-color-3);
}

.request-preview {
  font-size: 11px;
  color: var(--n-text-color-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 4px;
}

.list-pagination {
  padding: 8px;
  border-top: 1px solid var(--n-border-color);
  display: flex;
  justify-content: center;
  background: var(--n-color-embedded);
}
</style>
