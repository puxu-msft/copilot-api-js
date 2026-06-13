<script setup lang="ts">
import type {
  //
  HistoryEntry,
  MessageContent,
} from "@/types"

import ErrorBoundary from "@/components/ui/ErrorBoundary.vue"

import DetailResponseSection from "../DetailResponseSection.vue"
import HeadersComparisonSection from "../HeadersComparisonSection.vue"
import SseEventsSection from "../SseEventsSection.vue"

defineProps<{
  entry: HistoryEntry
  responseMessage: MessageContent | null
}>()
</script>

<template>
  <div class="stage-upstream">
    <!-- HTTP headers first, then parsed response blocks + raw SSE. -->
    <HeadersComparisonSection
      v-if="entry.httpHeaders?.outboundResponse"
      :outbound-response="entry.httpHeaders.outboundResponse"
    />
    <DetailResponseSection
      :entry="entry"
      :response-message="responseMessage"
    />
    <ErrorBoundary label="SSE events">
      <SseEventsSection
        v-if="entry.sseEvents?.length"
        :events="entry.sseEvents"
        title="SSE Events (upstream → proxy)"
      />
    </ErrorBoundary>
  </div>
</template>

<style scoped>
.stage-upstream {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
