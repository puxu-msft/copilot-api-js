<script setup lang="ts">
import type { TruncationInfo } from '@/types'
import { useFormatters } from '@/composables/useFormatters'

defineProps<{
  truncation: TruncationInfo
}>()

const { formatNumber, formatDuration } = useFormatters()
</script>

<template>
  <div class="truncation-divider">
    <div class="divider-line" />
    <div class="divider-content">
      <span class="divider-icon">✂</span>
      <span class="divider-text">
        {{ truncation.removedMessageCount }} messages truncated
      </span>
      <span class="divider-detail">
        {{ formatNumber(truncation.originalTokens) }} → {{ formatNumber(truncation.compactedTokens) }} tokens
        ({{ formatDuration(truncation.processingTimeMs) }})
      </span>
    </div>
    <div class="divider-line" />
  </div>
</template>

<style scoped>
.truncation-divider {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin: var(--spacing-md) 0;
}

.divider-line {
  flex: 1;
  height: 1px;
  background: var(--error);
  opacity: 0.4;
  border-style: dashed;
}

.divider-content {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  flex-shrink: 0;
}

.divider-icon {
  font-size: var(--font-size-sm);
}

.divider-text {
  font-size: var(--font-size-xs);
  color: var(--error);
  font-weight: 500;
}

.divider-detail {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  font-family: var(--font-mono);
}
</style>
