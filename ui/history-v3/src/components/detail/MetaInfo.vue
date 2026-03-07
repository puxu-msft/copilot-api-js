<script setup lang="ts">
import type { HistoryEntry } from '@/types'
import { useFormatters } from '@/composables/useFormatters'
import BaseBadge from '@/components/ui/BaseBadge.vue'

defineProps<{
  entry: HistoryEntry
}>()

const { formatNumber, formatDuration, formatDate } = useFormatters()
</script>

<template>
  <div class="meta-grid">
    <div class="meta-row">
      <span class="meta-label">Time</span>
      <span class="meta-value">{{ formatDate(entry.timestamp) }}</span>
    </div>
    <div class="meta-row">
      <span class="meta-label">Model</span>
      <span class="meta-value">{{ entry.response?.model || entry.request.model || '-' }}</span>
    </div>
    <div class="meta-row">
      <span class="meta-label">Endpoint</span>
      <span class="meta-value">
        <BaseBadge :color="entry.endpoint === 'anthropic-messages' ? 'purple' : entry.endpoint === 'openai-responses' ? 'green' : 'cyan'">
          {{ entry.endpoint }}
        </BaseBadge>
      </span>
    </div>
    <div class="meta-row">
      <span class="meta-label">Stream</span>
      <span class="meta-value">{{ entry.request.stream === true ? 'Yes' : 'No' }}</span>
    </div>
    <div v-if="entry.request.max_tokens" class="meta-row">
      <span class="meta-label">Max Tokens</span>
      <span class="meta-value">{{ formatNumber(entry.request.max_tokens) }}</span>
    </div>
    <div v-if="entry.request.temperature !== undefined" class="meta-row">
      <span class="meta-label">Temperature</span>
      <span class="meta-value">{{ entry.request.temperature }}</span>
    </div>
    <div v-if="entry.durationMs" class="meta-row">
      <span class="meta-label">Duration</span>
      <span class="meta-value">{{ formatDuration(entry.durationMs) }}</span>
    </div>
    <div v-if="entry.response?.stop_reason" class="meta-row">
      <span class="meta-label">Stop Reason</span>
      <span class="meta-value">{{ entry.response.stop_reason }}</span>
    </div>

    <!-- Token Usage -->
    <div v-if="entry.response?.usage" class="meta-section">
      <div class="meta-section-title">Token Usage</div>
      <div class="meta-row">
        <span class="meta-label">Input</span>
        <span class="meta-value mono">{{ formatNumber(entry.response.usage.input_tokens) }}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Output</span>
        <span class="meta-value mono">{{ formatNumber(entry.response.usage.output_tokens) }}</span>
      </div>
      <div v-if="entry.response?.usage?.cache_read_input_tokens" class="meta-row">
        <span class="meta-label">Cache Read</span>
        <span class="meta-value mono">{{ formatNumber(entry.response.usage.cache_read_input_tokens) }}</span>
      </div>
      <div v-if="entry.response?.usage?.cache_creation_input_tokens" class="meta-row">
        <span class="meta-label">Cache Create</span>
        <span class="meta-value mono">{{ formatNumber(entry.response.usage.cache_creation_input_tokens) }}</span>
      </div>
    </div>

    <!-- Error -->
    <div v-if="entry.response?.error" class="meta-row meta-error">
      <span class="meta-label">Error</span>
      <span class="meta-value error-text">{{ entry.response.error }}</span>
    </div>

    <!-- Tools -->
    <div v-if="entry.request.tools?.length" class="meta-row">
      <span class="meta-label">Tools</span>
      <span class="meta-value">{{ entry.request.tools.length }} defined</span>
    </div>

    <!-- Truncation -->
    <div v-if="entry.rewrites?.truncation" class="meta-section">
      <div class="meta-section-title">Truncation</div>
      <div class="meta-row">
        <span class="meta-label">Removed</span>
        <span class="meta-value">{{ entry.rewrites.truncation.removedMessageCount }} messages</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Tokens</span>
        <span class="meta-value mono">{{ formatNumber(entry.rewrites.truncation.originalTokens) }} → {{ formatNumber(entry.rewrites.truncation.compactedTokens) }}</span>
      </div>
    </div>

    <!-- Preprocessing -->
    <div v-if="entry.rewrites?.preprocessing && (entry.rewrites.preprocessing.strippedReadTagCount > 0 || entry.rewrites.preprocessing.dedupedToolCallCount > 0)" class="meta-section">
      <div class="meta-section-title">Preprocessing</div>
      <div v-if="entry.rewrites.preprocessing.strippedReadTagCount" class="meta-row">
        <span class="meta-label">Read tag strip</span>
        <span class="meta-value">{{ entry.rewrites.preprocessing.strippedReadTagCount }} tags</span>
      </div>
      <div v-if="entry.rewrites.preprocessing.dedupedToolCallCount" class="meta-row">
        <span class="meta-label">Dedup tool calls</span>
        <span class="meta-value">{{ entry.rewrites.preprocessing.dedupedToolCallCount }} pairs</span>
      </div>
    </div>

    <!-- Sanitization -->
    <div v-if="entry.rewrites?.sanitization?.length" class="meta-section">
      <div class="meta-section-title">Sanitization</div>
      <template v-for="(san, idx) in entry.rewrites.sanitization" :key="idx">
        <div v-if="entry.rewrites.sanitization.length > 1" class="meta-row">
          <span class="meta-label meta-label--attempt">Attempt {{ idx + 1 }}</span>
        </div>
        <div v-if="san.totalBlocksRemoved" class="meta-row">
          <span class="meta-label">Blocks Removed</span>
          <span class="meta-value">{{ san.totalBlocksRemoved }} total</span>
        </div>
        <div v-if="san.orphanedToolUseCount" class="meta-row">
          <span class="meta-label">Orphan tool_use</span>
          <span class="meta-value">{{ san.orphanedToolUseCount }}</span>
        </div>
        <div v-if="san.orphanedToolResultCount" class="meta-row">
          <span class="meta-label">Orphan tool_result</span>
          <span class="meta-value">{{ san.orphanedToolResultCount }}</span>
        </div>
        <div v-if="san.emptyTextBlocksRemoved" class="meta-row">
          <span class="meta-label">Empty text</span>
          <span class="meta-value">{{ san.emptyTextBlocksRemoved }}</span>
        </div>
        <div v-if="san.systemReminderRemovals" class="meta-row">
          <span class="meta-label">Reminders</span>
          <span class="meta-value">{{ san.systemReminderRemovals }} tags filtered</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.meta-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.meta-row {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-sm);
  padding: 2px 0;
}

.meta-label {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  min-width: 90px;
  flex-shrink: 0;
}

.meta-label--attempt {
  font-weight: 600;
  color: var(--text-muted);
}

.meta-value {
  font-size: var(--font-size-xs);
  color: var(--text);
}

.meta-value.mono {
  font-family: var(--font-mono);
}

.meta-section {
  margin-top: var(--spacing-xs);
  padding-top: var(--spacing-xs);
  border-top: 1px solid var(--border-light);
}

.meta-section .meta-row {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-md);
  padding: 2px 0;
}

.meta-section-title {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: var(--spacing-xs);
}

.error-text {
  color: var(--error);
}
</style>
