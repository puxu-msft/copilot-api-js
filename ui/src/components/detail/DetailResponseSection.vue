<script setup lang="ts">
import type { HistoryEntry, MessageContent } from "@/types"

import MessageBlock from "@/components/message/MessageBlock.vue"
import ErrorBoundary from "@/components/ui/ErrorBoundary.vue"

import SectionBlock from "./SectionBlock.vue"

defineProps<{
  entry: HistoryEntry
  responseMessage: MessageContent | null
}>()
</script>

<template>
  <SectionBlock
    v-if="responseMessage || entry.response?.error"
    title="Response"
    :badge="responseMessage ? '1 message' : ''"
    :raw-data="entry.response"
    raw-title="Response"
  >
    <div
      v-if="entry.response?.error"
      class="response-error"
    >
      <span class="error-label">Error</span>
      <span class="error-text">{{ entry.response.error }}</span>
    </div>

    <ErrorBoundary label="Response message">
      <MessageBlock
        v-if="responseMessage"
        :message="responseMessage"
        :index="0"
      />
    </ErrorBoundary>
  </SectionBlock>
</template>

<style scoped>
.response-error {
  background: var(--error-muted);
  border: 1px solid var(--error);
  padding: var(--spacing-sm);
  margin-bottom: var(--spacing-sm);
  display: flex;
  align-items: baseline;
  gap: var(--spacing-sm);
}

.error-label {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--error);
  letter-spacing: 0.5px;
}

.error-text {
  font-size: var(--font-size-sm);
  color: var(--error);
  white-space: pre-wrap;
  word-wrap: break-word;
}
</style>
