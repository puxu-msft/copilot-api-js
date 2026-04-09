<script setup lang="ts">
import { useFormatters } from "@/composables/useFormatters"

interface AttemptInfo {
  index: number
  strategy?: string
  durationMs: number
  error?: string
  truncation?: {
    wasTruncated: boolean
    removedMessageCount: number
    originalTokens: number
    compactedTokens: number
  }
  effectiveMessageCount?: number
}

defineProps<{
  attempts: Array<AttemptInfo>
}>()

const { formatDuration, formatNumber } = useFormatters()

function nodeColor(attempt: AttemptInfo): string {
  if (attempt.error) return "var(--error)"
  return "var(--success)"
}
</script>

<template>
  <div class="attempts-timeline">
    <div class="timeline-title">Retry Timeline ({{ attempts.length }} attempts)</div>
    <div class="timeline-track">
      <div
        v-for="attempt in attempts"
        :key="attempt.index"
        class="timeline-node"
      >
        <div
          class="node-dot"
          :style="{ background: nodeColor(attempt) }"
        />
        <div class="node-info">
          <div class="node-header">
            <span class="node-index">#{{ attempt.index + 1 }}</span>
            <span
              v-if="attempt.strategy"
              class="node-strategy"
              >{{ attempt.strategy }}</span
            >
            <span class="node-duration">{{ formatDuration(attempt.durationMs) }}</span>
          </div>
          <div
            v-if="attempt.error"
            class="node-error"
          >
            {{ attempt.error }}
          </div>
          <div
            v-if="attempt.truncation?.wasTruncated"
            class="node-truncation"
          >
            Truncated: {{ formatNumber(attempt.truncation.originalTokens) }} ->
            {{ formatNumber(attempt.truncation.compactedTokens) }} tokens,
            {{ attempt.truncation.removedMessageCount }} msg removed
          </div>
          <div
            v-if="attempt.effectiveMessageCount"
            class="node-meta"
          >
            {{ attempt.effectiveMessageCount }} messages
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.attempts-timeline {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.timeline-title {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-muted);
}

.timeline-track {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  padding-left: var(--spacing-sm);
  border-left: 2px solid var(--border);
}

.timeline-node {
  display: flex;
  gap: var(--spacing-sm);
  align-items: flex-start;
  position: relative;
}

.node-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 2px;
  margin-left: -7px;
}

.node-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.node-header {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-sm);
}

.node-index {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text);
}

.node-strategy {
  font-size: 10px;
  padding: 0 4px;
  background: var(--primary-muted);
  color: var(--primary);
}

.node-duration {
  font-size: 10px;
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.node-error {
  font-size: 10px;
  color: var(--error);
  word-break: break-word;
}

.node-truncation {
  font-size: 10px;
  color: var(--warning);
}

.node-meta {
  font-size: 10px;
  color: var(--text-dim);
}
</style>
