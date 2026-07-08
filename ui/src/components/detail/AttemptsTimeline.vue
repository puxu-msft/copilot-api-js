<script setup lang="ts">
import type {
  //
  HistoryEntry,
  TruncationInfo,
} from "@/types"

import {
  //
  formatDuration,
  formatNumber,
} from "@/utils/formatters"

type Attempt = NonNullable<HistoryEntry["attempts"]>[number]

defineProps<{
  attempts: Array<Attempt>
}>()

function nodeColor(attempt: Attempt): string {
  if (attempt.error) return "var(--error)"
  return "var(--success)"
}

/** This attempt's truncation info: new `effectiveSource.pipeline.truncation`. */
function attemptTruncation(attempt: Attempt): TruncationInfo | undefined {
  return attempt.effectiveSource?.pipeline?.truncation
}

/** This attempt's effective message count: new `effectiveSource.messageCount`. */
function attemptMessageCount(attempt: Attempt): number | undefined {
  return attempt.effectiveSource?.messageCount
}

/** Upstream-original SSE frames captured before this attempt's cutoff: new `upstreamResponse.sseEvents`. */
function attemptFrames(attempt: Attempt): ReadonlyArray<unknown> | undefined {
  return attempt.upstreamResponse?.sseEvents
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
            v-if="attemptTruncation(attempt)?.wasTruncated"
            class="node-truncation"
          >
            Truncated: {{ formatNumber(attemptTruncation(attempt)!.originalTokens) }} -> {{ formatNumber(attemptTruncation(attempt)!.compactedTokens) }} tokens,
            {{ attemptTruncation(attempt)!.removedMessageCount }} msg removed
          </div>
          <div
            v-if="attemptMessageCount(attempt)"
            class="node-meta"
          >
            {{ attemptMessageCount(attempt) }} messages
          </div>
          <div
            v-if="attempt.error && attemptFrames(attempt)?.length"
            class="node-meta"
          >
            {{ attemptFrames(attempt)?.length }} upstream frames before cutoff
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
