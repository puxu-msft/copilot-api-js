<script setup lang="ts">
import type { HistoryEntry } from "@/types"

import ErrorBoundary from "@/components/ui/ErrorBoundary.vue"

import SectionBlock from "../SectionBlock.vue"
import SseEventsSection from "../SseEventsSection.vue"
import SseFrameDiff from "../SseFrameDiff.vue"

defineProps<{ entry: HistoryEntry }>()
</script>

<template>
  <div class="stage-forwarded">
    <!-- Upstream-vs-client aligned frame diff (the actionable "what changed"). -->
    <ErrorBoundary label="SSE frame diff">
      <SseFrameDiff
        v-if="entry.sseEvents?.length && entry.inboundResponse?.sseEvents?.length"
        :upstream="entry.sseEvents"
        :forwarded="entry.inboundResponse.sseEvents"
      />
    </ErrorBoundary>

    <ErrorBoundary label="Forwarded SSE events">
      <SseEventsSection
        v-if="entry.inboundResponse?.sseEvents?.length"
        :events="entry.inboundResponse.sseEvents"
        title="SSE Events (proxy → client)"
      />
    </ErrorBoundary>

    <ErrorBoundary label="Forwarded response">
      <SectionBlock
        v-if="entry.inboundResponse?.content != null"
        title="Forwarded Response (proxy → client)"
        anchor="forwarded"
        :raw-data="entry.inboundResponse.content"
        raw-title="Forwarded Response"
      >
        <pre class="stage-json">{{ JSON.stringify(entry.inboundResponse.content, null, 2) }}</pre>
      </SectionBlock>
    </ErrorBoundary>
  </div>
</template>

<style scoped>
.stage-forwarded {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.stage-json {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
</style>
