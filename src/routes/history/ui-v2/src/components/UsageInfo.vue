<script setup lang="ts">
import { NTag } from 'naive-ui'
import type { UsageData } from '@/types'
import { formatNumber, formatDuration } from '@/composables/useFormatters'

defineProps<{
  usage: UsageData
  durationMs?: number
  success?: boolean
}>()
</script>

<template>
  <div class="usage-info">
    <div class="usage-item">
      <div class="usage-label">Input Tokens</div>
      <div class="usage-value">{{ formatNumber(usage.input_tokens) }}</div>
    </div>
    <div class="usage-item">
      <div class="usage-label">Output Tokens</div>
      <div class="usage-value">{{ formatNumber(usage.output_tokens) }}</div>
    </div>
    <div v-if="usage.cache_read_input_tokens" class="usage-item">
      <div class="usage-label">Cached</div>
      <div class="usage-value">{{ formatNumber(usage.cache_read_input_tokens) }}</div>
    </div>
    <div class="usage-item">
      <div class="usage-label">Duration</div>
      <div class="usage-value">{{ formatDuration(durationMs) }}</div>
    </div>
    <div class="usage-item">
      <div class="usage-label">Status</div>
      <div class="usage-value">
        <NTag :type="success !== false ? 'success' : 'error'" size="small">
          {{ success !== false ? 'Success' : 'Failed' }}
        </NTag>
      </div>
    </div>
  </div>
</template>

<style scoped>
.usage-info {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
  gap: 10px;
  padding: 10px;
  background: var(--n-color-embedded);
  border-radius: 6px;
  margin-top: 12px;
}

.usage-item {
  text-align: center;
}

.usage-label {
  font-size: 10px;
  color: var(--n-text-color-3);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.usage-value {
  font-size: 14px;
  font-weight: 600;
  margin-top: 2px;
}
</style>
