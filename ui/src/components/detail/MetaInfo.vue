<script setup lang="ts">
import type { HistoryEntry } from "@/types"

import BaseBadge from "@/components/ui/BaseBadge.vue"
import {
  //
  formatDate,
  formatDuration,
  formatNumber,
} from "@/utils/formatters"
import { statusMeta } from "@/utils/status-meta"

defineProps<{
  entry: HistoryEntry
}>()
</script>

<template>
  <div class="meta-grid">
    <div class="meta-row">
      <span class="meta-label">Request Id</span>
      <span class="meta-value mono">{{ entry.id }}</span>
    </div>
    <div
      v-if="entry.sessionId"
      class="meta-row"
    >
      <span class="meta-label">Session Id</span>
      <span class="meta-value mono">{{ entry.sessionId }}</span>
    </div>
    <div class="meta-row">
      <span class="meta-label">Time</span>
      <span class="meta-value">{{ formatDate(entry.startedAt) }}</span>
    </div>
    <div
      v-if="entry.rawPath"
      class="meta-row"
    >
      <span class="meta-label">Path</span>
      <span class="meta-value mono">{{ entry.rawPath }}</span>
    </div>
    <div class="meta-row">
      <span class="meta-label">State</span>
      <span class="meta-value">
        <v-chip
          :color="statusMeta(entry.state).color"
          size="x-small"
          variant="tonal"
          label
          >{{ statusMeta(entry.state).label }}</v-chip
        >
      </span>
    </div>
    <div
      v-if="entry.process"
      class="meta-row"
    >
      <span class="meta-label">Process</span>
      <span class="meta-value mono">
        pid {{ entry.process.pid }}<template v-if="entry.process.version"> · {{ entry.process.version }}</template
        ><template v-if="entry.process.gitSha"> · {{ entry.process.gitSha }}</template>
      </span>
    </div>
    <div class="meta-row">
      <span class="meta-label">Model</span>
      <span class="meta-value">{{ entry.outboundResponse?.model || entry.inboundRequest.model || "-" }}</span>
    </div>
    <div class="meta-row">
      <span class="meta-label">Endpoint</span>
      <span class="meta-value">
        <BaseBadge
          :color="
            entry.endpoint === 'anthropic-messages' ? 'purple'
            : entry.endpoint === 'openai-responses' ? 'green'
            : entry.endpoint === 'gemini-generate-content' ? 'pink'
            : 'cyan'
          "
        >
          {{ entry.endpoint }}
        </BaseBadge>
      </span>
    </div>
    <div
      v-if="entry.outboundResponse?.status"
      class="meta-row"
    >
      <span class="meta-label">HTTP Status</span>
      <span
        class="meta-value"
        :class="{
          'text-error': entry.outboundResponse.status >= 400,
          'text-success': entry.outboundResponse.status < 300,
        }"
      >
        {{ entry.outboundResponse.status }}
      </span>
    </div>
    <div class="meta-row">
      <span class="meta-label">Stream</span>
      <span class="meta-value">{{ entry.inboundRequest.stream === true ? "Yes" : "No" }}</span>
    </div>
    <div
      v-if="entry.transport"
      class="meta-row"
    >
      <span class="meta-label">Transport</span>
      <span class="meta-value">{{ entry.transport }}</span>
    </div>
    <div
      v-if="entry.attemptCount !== undefined"
      class="meta-row"
    >
      <span class="meta-label">Attempts</span>
      <span class="meta-value mono">{{ entry.attemptCount }}</span>
    </div>
    <div
      v-if="entry.currentStrategy"
      class="meta-row"
    >
      <span class="meta-label">Strategy</span>
      <span class="meta-value">{{ entry.currentStrategy }}</span>
    </div>
    <div
      v-if="entry.queueWaitMs !== undefined"
      class="meta-row"
    >
      <span class="meta-label">Queue Wait</span>
      <span class="meta-value">{{ formatDuration(entry.queueWaitMs) }}</span>
    </div>
    <div
      v-if="entry.inboundRequest.max_tokens"
      class="meta-row"
    >
      <span class="meta-label">Max Tokens</span>
      <span class="meta-value">{{ formatNumber(entry.inboundRequest.max_tokens) }}</span>
    </div>
    <div
      v-if="entry.inboundRequest.temperature !== undefined"
      class="meta-row"
    >
      <span class="meta-label">Temperature</span>
      <span class="meta-value">{{ entry.inboundRequest.temperature }}</span>
    </div>
    <div
      v-if="entry.durationMs"
      class="meta-row"
    >
      <span class="meta-label">Duration</span>
      <span class="meta-value">{{ formatDuration(entry.durationMs) }}</span>
    </div>
    <div
      v-if="entry.outboundResponse?.stop_reason"
      class="meta-row"
    >
      <span class="meta-label">Stop Reason</span>
      <span class="meta-value">{{ entry.outboundResponse.stop_reason }}</span>
    </div>
    <div
      v-if="entry.lastUpdatedAt"
      class="meta-row"
    >
      <span class="meta-label">Last Update</span>
      <span class="meta-value">{{ formatDate(entry.lastUpdatedAt) }}</span>
    </div>

    <!-- Token Usage -->
    <div
      v-if="entry.outboundResponse?.usage"
      class="meta-section"
    >
      <div class="meta-section-title">Token Usage</div>
      <div class="meta-row">
        <span class="meta-label">Input</span>
        <span class="meta-value mono">{{ formatNumber(entry.outboundResponse.usage.input_tokens) }}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Output</span>
        <span class="meta-value mono">{{ formatNumber(entry.outboundResponse.usage.output_tokens) }}</span>
      </div>
      <div
        v-if="entry.outboundResponse?.usage?.cache_read_input_tokens"
        class="meta-row"
      >
        <span class="meta-label">Cache Read</span>
        <span class="meta-value mono">{{ formatNumber(entry.outboundResponse.usage.cache_read_input_tokens) }}</span>
      </div>
      <div
        v-if="entry.outboundResponse?.usage?.cache_creation_input_tokens"
        class="meta-row"
      >
        <span class="meta-label">Cache Create</span>
        <span class="meta-value mono">{{ formatNumber(entry.outboundResponse.usage.cache_creation_input_tokens) }}</span>
      </div>
    </div>

    <!-- Error -->
    <div
      v-if="entry.outboundResponse?.error"
      class="meta-row meta-error"
    >
      <span class="meta-label">Error</span>
      <span class="meta-value error-text">{{ entry.outboundResponse.error }}</span>
    </div>

    <!-- Raw Body (shown when error + rawBody exists) -->
    <div
      v-if="entry.outboundResponse?.error && entry.outboundResponse?.rawBody"
      class="meta-section"
    >
      <div class="meta-section-title">Raw Response Body</div>
      <pre class="raw-body">{{ entry.outboundResponse.rawBody }}</pre>
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
      v-if="entry.inboundRequest.tools?.length"
      class="meta-row"
    >
      <span class="meta-label">Tools</span>
      <span class="meta-value">{{ entry.inboundRequest.tools.length }} defined</span>
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
          >{{ formatNumber(entry.pipelineInfo.truncation.originalTokens) }} -> {{ formatNumber(entry.pipelineInfo.truncation.compactedTokens) }}</span
        >
      </div>
    </div>

    <!-- Preprocessing -->
    <div
      v-if="
        entry.pipelineInfo?.preprocessing
        && (entry.pipelineInfo.preprocessing.strippedReadTagCount > 0 || entry.pipelineInfo.preprocessing.dedupedToolCallCount > 0)
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
          v-if="san.emptyThinkingBlocksRemoved"
          class="meta-row"
        >
          <span class="meta-label">Corrupt thinking</span>
          <span class="meta-value">{{ san.emptyThinkingBlocksRemoved }}</span>
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
}
</style>
