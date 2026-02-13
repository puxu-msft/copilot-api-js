<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { NInput, NSelect, NSwitch, NButton, NEmpty, NIcon, NTag } from 'naive-ui'
import { CodeSlashOutline, ChevronDown, ChevronForward } from '@vicons/ionicons5'
import type { HistoryEntry, ContentBlock } from '@/types'
import MessageBlock from './MessageBlock.vue'
import RawJsonModal from './RawJsonModal.vue'
import { formatDate, formatDuration, formatNumber } from '@/composables/useFormatters'

const props = defineProps<{
  entry: HistoryEntry | null
}>()

defineEmits<{
  close: []
}>()

// View state
const aggregateTools = ref(true)
const searchQuery = ref('')
const filterRole = ref<string | null>(null)
const filterType = ref<string | null>(null)

// Section collapse state
const metaCollapsed = ref(false)
const requestCollapsed = ref(false)
const responseCollapsed = ref(false)

// Raw modal
const rawModalVisible = ref(false)
const rawModalTitle = ref('')
const rawModalData = ref<unknown>(null)

// Search debounce
let searchTimeout: ReturnType<typeof setTimeout>
const localSearch = ref('')

const handleSearchInput = (value: string) => {
  localSearch.value = value
  clearTimeout(searchTimeout)
  searchTimeout = setTimeout(() => {
    searchQuery.value = value
  }, 300)
}

const roleOptions = [
  { label: 'All Roles', value: '' },
  { label: 'System', value: 'system' },
  { label: 'User', value: 'user' },
  { label: 'Assistant', value: 'assistant' }
]

const typeOptions = [
  { label: 'All Types', value: '' },
  { label: 'Text', value: 'text' },
  { label: 'Tool Use', value: 'tool_use' },
  { label: 'Tool Result', value: 'tool_result' },
  { label: 'Image', value: 'image' }
]

// Build tool result map for aggregation
const toolResultMap = computed(() => {
  const map: Record<string, ContentBlock> = {}
  if (!props.entry || !aggregateTools.value) return map

  const messages = props.entry.request?.messages || []
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          map[block.tool_use_id] = block
        }
      }
    }
  }
  return map
})

// Filter messages
const filteredRequestMessages = computed(() => {
  if (!props.entry) return []
  const messages = props.entry.request?.messages || []

  return messages.filter(msg => {
    if (filterRole.value && msg.role !== filterRole.value) return false
    return true
  })
})

// Meta items for grid display (single unified grid)
const metaItems = computed(() => {
  if (!props.entry) return []
  const items: Array<{ label: string; value?: string; tag?: { type: 'info' | 'warning' | 'success' | 'error'; text: string } }> = []

  items.push({ label: 'Time', value: formatDate(props.entry.timestamp) })
  items.push({ label: 'Model', value: props.entry.request?.model || '-' })
  items.push({ label: 'Endpoint', tag: { type: props.entry.endpoint === 'anthropic' ? 'info' : 'warning', text: props.entry.endpoint } })

  if (props.entry.request?.stream) {
    items.push({ label: 'Stream', tag: { type: 'success', text: 'yes' } })
  }
  if (props.entry.request?.max_tokens) {
    items.push({ label: 'Max Tokens', value: String(props.entry.request.max_tokens) })
  }
  if (props.entry.request?.temperature != null) {
    items.push({ label: 'Temperature', value: String(props.entry.request.temperature) })
  }
  if (props.entry.request?.tools?.length) {
    items.push({ label: 'Tools', value: props.entry.request.tools.length + ' defined' })
  }
  if (props.entry.response?.stop_reason) {
    items.push({ label: 'Stop Reason', value: props.entry.response.stop_reason })
  }
  if (props.entry.response?.success !== undefined) {
    items.push({
      label: 'Status',
      tag: {
        type: props.entry.response.success !== false ? 'success' : 'error',
        text: props.entry.response.success !== false ? 'OK' : 'Failed',
      },
    })
  }

  // Usage items
  const usage = props.entry.response?.usage
  if (usage) {
    items.push({ label: 'Input Tokens', value: formatNumber(usage.input_tokens) })
    items.push({ label: 'Output Tokens', value: formatNumber(usage.output_tokens) })
    if (usage.cache_read_input_tokens) {
      items.push({ label: 'Cached', value: formatNumber(usage.cache_read_input_tokens) })
    }
  }

  // Rewrite info
  const rewrites = props.entry.rewrites
  const truncation = rewrites?.truncation || props.entry.truncation
  if (truncation) {
    items.push({ label: 'Truncated', tag: { type: 'warning', text: `${truncation.removedMessageCount} msgs removed` } })
    items.push({ label: 'Tokens', value: `${formatNumber(truncation.originalTokens)} → ${formatNumber(truncation.compactedTokens)}` })
    if (truncation.processingTimeMs) {
      items.push({ label: 'Truncate Time', value: formatDuration(truncation.processingTimeMs) })
    }
  }
  if (rewrites?.sanitization) {
    const s = rewrites.sanitization
    if (s.removedBlockCount > 0) {
      items.push({ label: 'Orphaned', tag: { type: 'error', text: `${s.removedBlockCount} blocks removed` } })
    }
    if (s.systemReminderRemovals > 0) {
      items.push({ label: 'Reminders', tag: { type: 'info', text: `${s.systemReminderRemovals} tags filtered` } })
    }
  }

  // Duration (once, at the end)
  if (props.entry.durationMs) {
    items.push({ label: 'Duration', value: formatDuration(props.entry.durationMs) })
  }

  return items
})

// Number of columns for two equal rows
const metaGridCols = computed(() => Math.ceil(metaItems.value.length / 2))

const showRaw = (title: string, data: unknown) => {
  rawModalTitle.value = title
  rawModalData.value = data
  rawModalVisible.value = true
}

// Check if a message contains system-reminder tags (indicating it was rewritten)
const systemReminderPattern = /<system-reminder>[\s\S]*?<\/system-reminder>/
const hasRewrittenMessage = (msg: { content: string | Array<{ type: string; text?: string }> }): boolean => {
  if (typeof msg.content === 'string') {
    return systemReminderPattern.test(msg.content)
  }
  if (Array.isArray(msg.content)) {
    return msg.content.some(b => b.type === 'text' && b.text && systemReminderPattern.test(b.text))
  }
  return false
}

// Reset state when entry changes
watch(() => props.entry, () => {
  localSearch.value = ''
  searchQuery.value = ''
  metaCollapsed.value = false
  requestCollapsed.value = false
  responseCollapsed.value = false
})
</script>

<template>
  <div class="detail-panel">
    <template v-if="!entry">
      <div class="detail-empty">
        <NEmpty description="Select a request to view details" />
      </div>
    </template>

    <template v-else>
      <div class="detail-toolbar">
        <NInput
          :value="localSearch"
          placeholder="Search in conversation..."
          size="small"
          clearable
          style="max-width: 250px"
          @update:value="handleSearchInput"
        />

        <div class="detail-filters">
          <NSelect
            :value="filterRole || ''"
            :options="roleOptions"
            size="small"
            style="width: 120px"
            @update:value="filterRole = $event || null"
          />
          <NSelect
            :value="filterType || ''"
            :options="typeOptions"
            size="small"
            style="width: 120px"
            @update:value="filterType = $event || null"
          />
        </div>

        <div class="detail-toggle">
          <NSwitch v-model:value="aggregateTools" size="small" />
          <span class="toggle-label">Aggregate Tools</span>
        </div>
      </div>

      <div class="detail-content">
        <div class="conversation">
            <!-- META INFO Section -->
            <div class="section-block">
              <div class="section-header">
                <div class="section-header-left" @click="metaCollapsed = !metaCollapsed">
                  <NIcon size="14" class="collapse-icon">
                    <ChevronDown v-if="!metaCollapsed" />
                    <ChevronForward v-else />
                  </NIcon>
                  <span class="section-title">META INFO</span>
                </div>
                <NButton
                  text
                  size="tiny"
                  class="action-btn"
                  @click.stop="showRaw('Full Entry', entry)"
                >
                  <template #icon>
                    <NIcon><CodeSlashOutline /></NIcon>
                  </template>
                  Raw
                </NButton>
              </div>

              <template v-if="!metaCollapsed">
                <div class="info-card" :style="{ gridTemplateColumns: `repeat(${metaGridCols}, 1fr)` }">
                  <div v-for="item in metaItems" :key="item.label" class="info-item">
                    <div class="info-label">{{ item.label }}</div>
                    <div class="info-value">
                      <NTag v-if="item.tag" :type="item.tag.type" size="tiny" :bordered="false">
                        {{ item.tag.text }}
                      </NTag>
                      <span v-else>{{ item.value }}</span>
                    </div>
                  </div>
                </div>
              </template>
            </div>

            <!-- REQUEST Section -->
            <div class="section-block">
              <div class="section-header">
                <div class="section-header-left" @click="requestCollapsed = !requestCollapsed">
                  <NIcon size="14" class="collapse-icon">
                    <ChevronDown v-if="!requestCollapsed" />
                    <ChevronForward v-else />
                  </NIcon>
                  <span class="section-title">REQUEST</span>
                  <span class="section-badge">{{ (entry.request?.messages || []).length }} messages</span>
                </div>
                <NButton
                  text
                  size="tiny"
                  class="action-btn"
                  @click.stop="showRaw('Request', entry.request)"
                >
                  <template #icon>
                    <NIcon><CodeSlashOutline /></NIcon>
                  </template>
                  Raw
                </NButton>
              </div>

              <div v-if="!requestCollapsed" class="section-body">
                <!-- System message -->
                <MessageBlock
                  v-if="entry.request?.system && (!filterRole || filterRole === 'system')"
                  role="system"
                  :content="entry.request.system"
                  :search-query="searchQuery"
                  :filter-type="filterType"
                  @show-raw="showRaw"
                />

                <!-- Messages -->
                <template v-for="(msg, index) in filteredRequestMessages" :key="index">
                  <!-- Truncation divider -->
                  <div
                    v-if="(entry.rewrites?.truncation || entry.truncation) && index === (entry.rewrites?.truncation || entry.truncation)!.removedMessageCount"
                    class="truncation-divider"
                  >
                    <div class="truncation-divider-line" />
                    <span class="truncation-divider-label">
                      {{ (entry.rewrites?.truncation || entry.truncation)!.removedMessageCount }} messages truncated &middot;
                      {{ formatNumber((entry.rewrites?.truncation || entry.truncation)!.originalTokens) }} → {{ formatNumber((entry.rewrites?.truncation || entry.truncation)!.compactedTokens) }} tokens
                    </span>
                    <div class="truncation-divider-line" />
                  </div>

                  <MessageBlock
                    :role="msg.role"
                    :content="msg.content"
                    :search-query="searchQuery"
                    :filter-type="filterType"
                    :aggregate-tools="aggregateTools"
                    :tool-result-map="toolResultMap"
                    :truncated="!!(entry.rewrites?.truncation || entry.truncation) && index < (entry.rewrites?.truncation || entry.truncation)!.removedMessageCount"
                    :rewritten="hasRewrittenMessage(msg)"
                    @show-raw="showRaw"
                  />
                </template>
              </div>
            </div>

            <!-- RESPONSE Section -->
            <div class="section-block">
              <div class="section-header">
                <div class="section-header-left" @click="responseCollapsed = !responseCollapsed">
                  <NIcon size="14" class="collapse-icon">
                    <ChevronDown v-if="!responseCollapsed" />
                    <ChevronForward v-else />
                  </NIcon>
                  <span class="section-title">RESPONSE</span>
                </div>
                <NButton
                  text
                  size="tiny"
                  class="action-btn"
                  @click.stop="showRaw('Response', entry.response)"
                >
                  <template #icon>
                    <NIcon><CodeSlashOutline /></NIcon>
                  </template>
                  Raw
                </NButton>
              </div>
              <div v-if="!responseCollapsed" class="section-body">
                <!-- Response content -->
                <MessageBlock
                  v-if="entry.response?.content && (!filterRole || filterRole === 'assistant')"
                  role="assistant"
                  :content="entry.response.content"
                  :search-query="searchQuery"
                  :filter-type="filterType"
                  @show-raw="showRaw"
                />

                <!-- Error message -->
                <div v-if="entry.response?.error" class="error-block">
                  <strong>Error:</strong> {{ entry.response.error }}
                </div>
              </div>
            </div>
          </div>
        </div>

      <!-- Raw JSON Modal -->
      <RawJsonModal
        v-model:visible="rawModalVisible"
        :title="rawModalTitle"
        :data="rawModalData"
      />
    </template>

  </div>
</template>

<style scoped>
.detail-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--n-color);
  border-left: 1px solid var(--n-border-color);
}

.detail-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.detail-toolbar {
  padding: 8px 12px;
  border-bottom: 1px solid var(--n-border-color);
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--n-color-embedded);
  flex-wrap: wrap;
}

.detail-filters {
  display: flex;
  gap: 8px;
}

.detail-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
}

.toggle-label {
  font-size: 12px;
  color: var(--n-text-color-3);
}

.detail-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.conversation {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-block {
  border: 1px solid color-mix(in srgb, var(--n-border-color) 100%, var(--n-text-color-3) 30%);
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--n-color-embedded);
  border-bottom: 1px solid var(--n-border-color);
  user-select: none;
}

.section-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  padding: 2px 6px;
  margin: -2px -6px;
  border-radius: 4px;
}

.section-header-left:hover {
  background: var(--n-color-embedded-modal);
}

.action-btn {
  font-size: 11px;
}

.collapse-icon {
  color: var(--n-text-color-3);
  transition: transform 0.15s;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--n-text-color-3);
}

.section-badge {
  font-size: 10px;
  color: var(--n-text-color-3);
  opacity: 0.7;
  margin-left: 4px;
}

.section-body {
  padding: 12px;
}

/* Info card grid (meta info & usage) */
.info-card {
  display: grid;
  gap: 1px;
  background: var(--n-border-color);
  border-bottom: 1px solid var(--n-border-color);
}

.info-card .info-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 10px 8px;
  background: var(--n-color-embedded);
  text-align: center;
  gap: 4px;
}

.info-label {
  font-size: 10px;
  color: var(--n-text-color-3);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.info-value {
  font-size: 12px;
  font-weight: 500;
  font-family: 'SF Mono', Monaco, 'Courier New', monospace;
}

.error-block {
  padding: 12px;
  background: var(--n-error-color-suppl);
  color: var(--n-error-color);
  border-radius: 4px;
  margin-bottom: 12px;
}

.raw-view {
  background: var(--n-color-embedded);
  border-radius: 6px;
  padding: 12px;
  font-family: 'SF Mono', Monaco, 'Courier New', monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
  margin: 0;
}

.truncation-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px 0;
}

.truncation-divider-line {
  flex: 1;
  height: 1px;
  background: var(--n-error-color);
  opacity: 0.5;
}

.truncation-divider-label {
  font-size: 10px;
  color: var(--n-error-color);
  font-weight: 600;
  text-transform: uppercase;
  white-space: nowrap;
}
</style>
