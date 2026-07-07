<script setup lang="ts">
import { computed } from "vue"

import type {
  //
  HistoryEntry,
  MessageContent,
} from "@/types"

import MessageBlock from "@/components/message/MessageBlock.vue"
import ErrorBoundary from "@/components/ui/ErrorBoundary.vue"
import { resolveUpstreamResponse } from "@/composables/entry-legs"

import SectionBlock from "./SectionBlock.vue"

const props = defineProps<{
  entry: HistoryEntry
  responseMessage: MessageContent | null
}>()

// New final-attempt `upstreamResponse` ?? legacy `outboundResponse` (P4c: drop legacy arm in entry-legs).
const resp = computed(() => resolveUpstreamResponse(props.entry))
</script>

<template>
  <SectionBlock
    v-if="responseMessage || resp?.error"
    title="Response"
    anchor="response"
    :badge="responseMessage ? '1 message' : ''"
    :raw-data="resp"
    raw-title="Response"
  >
    <div
      v-if="resp?.error"
      class="response-error"
    >
      <span class="error-label">Error</span>
      <span class="error-text">{{ resp.error }}</span>
    </div>

    <ErrorBoundary label="Response message">
      <MessageBlock
        v-if="responseMessage"
        :message="responseMessage"
        :index="-1"
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
