<script setup lang="ts">
import type { HistoryEntry } from "@/types"

import BaseBadge from "@/components/ui/BaseBadge.vue"
import { useFormatters } from "@/composables/useFormatters"

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
      <span class="meta-value">{{ entry.response?.model || entry.request.model || "-" }}</span>
    </div>
    <div class="meta-row">
      <span class="meta-label">Endpoint</span>
      <span class="meta-value">
        <BaseBadge
          :color="
            entry.endpoint === 'anthropic-messages' ? 'purple'
            : entry.endpoint === 'openai-responses' ? 'green'
            : 'cyan'
          "
        >
          {{ entry.endpoint }}
        </BaseBadge>
      </span>
    </div>
    <div
      v-if="entry.response?.status"
      class="meta-row"
    >
      <span class="meta-label">HTTP Status</span>
      <span
        class="meta-value"
        :class="{
          'text-error': entry.response.status >= 400,
          'text-success': entry.response.status < 300,
        }"
      >
        {{ entry.response.status }}
      </span>
    </div>
    <div class="meta-row">
      <span class="meta-label">Stream</span>
      <span class="meta-value">{{ entry.request.stream === true ? "Yes" : "No" }}</span>
    </div>
    <div
      v-if="entry.request.max_tokens"
      class="meta-row"
    >
      <span class="meta-label">Max Tokens</span>
      <span class="meta-value">{{ formatNumber(entry.request.max_tokens) }}</span>
    </div>
    <div
      v-if="entry.request.temperature !== undefined"
      class="meta-row"
    >
      <span class="meta-label">Temperature</span>
      <span class="meta-value">{{ entry.request.temperature }}</span>
    </div>
    <div
      v-if="entry.durationMs"
      class="meta-row"
    >
      <span class="meta-label">Duration</span>
      <span class="meta-value">{{ formatDuration(entry.durationMs) }}</span>
    </div>
    <div
      v-if="entry.response?.stop_reason"
      class="meta-row"
    >
      <span class="meta-label">Stop Reason</span>
      <span class="meta-value">{{ entry.response.stop_reason }}</span>
    </div>

    <!-- Token Usage -->
    <div
      v-if="entry.response?.usage"
      class="meta-section"
    >
      <div class="meta-section-title">Token Usage</div>
      <div class="meta-row">
        <span class="meta-label">Input</span>
        <span class="meta-value mono">{{ formatNumber(entry.response.usage.input_tokens) }}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Output</span>
        <span class="meta-value mono">{{ formatNumber(entry.response.usage.output_tokens) }}</span>
      </div>
      <div
        v-if="entry.response?.usage?.cache_read_input_tokens"
        class="meta-row"
      >
        <span class="meta-label">Cache Read</span>
        <span class="meta-value mono">{{ formatNumber(entry.response.usage.cache_read_input_tokens) }}</span>
      </div>
      <div
        v-if="entry.response?.usage?.cache_creation_input_tokens"
        class="meta-row"
      >
        <span class="meta-label">Cache Create</span>
        <span class="meta-value mono">{{ formatNumber(entry.response.usage.cache_creation_input_tokens) }}</span>
      </div>
    </div>

    <!-- Error -->
    <div
      v-if="entry.response?.error"
      class="meta-row meta-error"
    >
      <span class="meta-label">Error</span>
      <span class="meta-value error-text">{{ entry.response.error }}</span>
    </div>

    <!-- Raw Body (shown when error + rawBody exists) -->
    <div
      v-if="entry.response?.error && entry.response?.rawBody"
      class="meta-section"
    >
      <div class="meta-section-title">Raw Response Body</div>
      <pre class="raw-body">{{ entry.response.rawBody }}</pre>
    </div>

    <div
      v-if="entry.warningMessages?.length"
      class="meta-section"
    >
      <div class="meta-section-title">Warnings</div>
      <div
        v-for="warning in entry.warningMessages"
        :key="`${warning.code}:${warning.message}`"
        class="meta-row"
      >
        <span class="meta-label meta-label--code">{{ warning.code }}</span>
        <span class="meta-value warning-text">{{ warning.message }}</span>
      </div>
    </div>

    <!-- Tools -->
    <div
      v-if="entry.request.tools?.length"
      class="meta-row"
    >
      <span class="meta-label">Tools</span>
      <span class="meta-value">{{ entry.request.tools.length }} defined</span>
    </div>

    <!-- Truncation -->
    <div
      v-if="entry.pipelineInfo?.truncation"
      class="meta-section"
    >
      <div class="meta-section-title">Truncation</div>
      <div class="meta-row">
        <span class="meta-label">Removed</span>
        <span class="meta-value">{{ entry.pipelineInfo.truncation.removedMessageCount }} messages</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Tokens</span>
        <span class="meta-value mono"
          >{{ formatNumber(entry.pipelineInfo.truncation.originalTokens) }} ->
          {{ formatNumber(entry.pipelineInfo.truncation.compactedTokens) }}</span
        >
      </div>
    </div>

    <!-- Preprocessing -->
    <div
      v-if="
        entry.pipelineInfo?.preprocessing
        && (entry.pipelineInfo.preprocessing.strippedReadTagCount > 0
          || entry.pipelineInfo.preprocessing.dedupedToolCallCount > 0)
      "
      class="meta-section"
    >
      <div class="meta-section-title">Preprocessing</div>
      <div
        v-if="entry.pipelineInfo.preprocessing.strippedReadTagCount"
        class="meta-row"
      >
        <span class="meta-label">Read tag strip</span>
        <span class="meta-value">{{ entry.pipelineInfo.preprocessing.strippedReadTagCount }} tags</span>
      </div>
      <div
        v-if="entry.pipelineInfo.preprocessing.dedupedToolCallCount"
        class="meta-row"
      >
        <span class="meta-label">Dedup tool calls</span>
        <span class="meta-value">{{ entry.pipelineInfo.preprocessing.dedupedToolCallCount }} pairs</span>
      </div>
    </div>

    <!-- Sanitization -->
    <div
      v-if="entry.pipelineInfo?.sanitization?.length"
      class="meta-section"
    >
      <div class="meta-section-title">Sanitization</div>
      <template
        v-for="(san, idx) in entry.pipelineInfo.sanitization"
        :key="idx"
      >
        <div
          v-if="entry.pipelineInfo.sanitization.length > 1"
          class="meta-row"
        >
          <span class="meta-label meta-label--attempt">Attempt {{ idx + 1 }}</span>
        </div>
        <div
          v-if="san.totalBlocksRemoved"
          class="meta-row"
        >
          <span class="meta-label">Blocks Removed</span>
          <span class="meta-value">{{ san.totalBlocksRemoved }} total</span>
        </div>
        <div
          v-if="san.orphanedToolUseCount"
          class="meta-row"
        >
          <span class="meta-label">Orphan tool_use</span>
          <span class="meta-value">{{ san.orphanedToolUseCount }}</span>
        </div>
        <div
          v-if="san.orphanedToolResultCount"
          class="meta-row"
        >
          <span class="meta-label">Orphan tool_result</span>
          <span class="meta-value">{{ san.orphanedToolResultCount }}</span>
        </div>
        <div
          v-if="san.emptyTextBlocksRemoved"
          class="meta-row"
        >
          <span class="meta-label">Empty text</span>
          <span class="meta-value">{{ san.emptyTextBlocksRemoved }}</span>
        </div>
        <div
          v-if="san.systemReminderRemovals"
          class="meta-row"
        >
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

.meta-label--code {
  font-family: var(--font-mono);
}

.meta-value {
  font-size: var(--font-size-xs);
  color: var(--text);
}

.meta-value.mono {
  font-family: var(--font-mono);
}

.text-success {
  color: var(--success);
}

.text-error {
  color: var(--error);
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

.warning-text {
  color: var(--warning);
}

.raw-body {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: var(--spacing-sm);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
}
</style>
