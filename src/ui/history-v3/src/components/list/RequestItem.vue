<script setup lang="ts">
import type { HistoryEntry } from '@/types'
import { getPreviewText, getStatusClass } from '@/composables/useHistoryStore'
import { useFormatters } from '@/composables/useFormatters'
import StatusDot from '@/components/ui/StatusDot.vue'
import BaseBadge from '@/components/ui/BaseBadge.vue'

defineProps<{
  entry: HistoryEntry
  selected: boolean
}>()

defineEmits<{
  select: [id: string]
}>()

const { formatDate, formatNumber, formatDuration } = useFormatters()
</script>

<template>
  <div
    class="request-item"
    :class="{ selected, ['status-' + getStatusClass(entry)]: true }"
    @click="$emit('select', entry.id)"
  >
    <div class="item-header">
      <StatusDot :status="getStatusClass(entry)" />
      <span class="item-time">{{ formatDate(entry.timestamp) }}</span>
      <span class="item-model">{{ entry.response?.model || entry.request.model }}</span>
    </div>
    <div class="item-meta">
      <BaseBadge :color="entry.endpoint === 'anthropic' ? 'purple' : 'cyan'">
        {{ entry.endpoint }}
      </BaseBadge>
      <BaseBadge v-if="entry.request.stream" color="primary">stream</BaseBadge>
      <span v-if="entry.response?.usage" class="item-tokens">
        {{ formatNumber(entry.response.usage.input_tokens) }} in /
        {{ formatNumber(entry.response.usage.output_tokens) }} out
      </span>
      <span v-if="entry.durationMs" class="item-duration">
        · {{ formatDuration(entry.durationMs) }}
      </span>
    </div>
    <div class="item-preview">{{ getPreviewText(entry) }}</div>
  </div>
</template>

<style scoped>
.request-item {
  padding: var(--spacing-sm) var(--spacing-md);
  border-bottom: 1px solid var(--border-light);
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: all var(--transition-fast);
}

.request-item:hover {
  background: var(--bg-hover);
}

.request-item.selected {
  background: var(--bg-selected);
  border-left-color: var(--primary);
}

.item-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: 2px;
}

.item-time {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.item-model {
  font-size: var(--font-size-xs);
  color: var(--text);
  font-weight: 500;
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

.item-meta {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  margin-bottom: 2px;
}

.item-tokens {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  font-family: var(--font-mono);
  margin-left: auto;
}

.item-duration {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.item-preview {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
