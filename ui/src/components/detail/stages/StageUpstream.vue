<script setup lang="ts">
import { computed } from "vue"

import type {
  //
  HistoryEntry,
  MessageContent,
} from "@/types"

import ErrorBoundary from "@/components/ui/ErrorBoundary.vue"
import {
  //
  resolveHeaders,
  resolveUpstreamSse,
} from "@/composables/entry-legs"

import DetailResponseSection from "../DetailResponseSection.vue"
import HeadersComparisonSection from "../HeadersComparisonSection.vue"
import SseEventsSection from "../SseEventsSection.vue"

const props = defineProps<{
  entry: HistoryEntry
  responseMessage: MessageContent | null
}>()

// New final-attempt `upstreamResponse` (legacy `outboundResponse`/`httpHeaders`/`sseEvents` removed in P4c).
const outboundResponseHeaders = computed(() => resolveHeaders(props.entry).outboundResponse)
const upstreamSse = computed(() => resolveUpstreamSse(props.entry))
</script>

<template>
  <div class="stage-upstream">
    <!-- HTTP headers first, then parsed response blocks + raw SSE. -->
    <HeadersComparisonSection
      v-if="outboundResponseHeaders"
      :outbound-response="outboundResponseHeaders"
    />
    <DetailResponseSection
      :entry="entry"
      :response-message="responseMessage"
    />
    <ErrorBoundary label="SSE events">
      <SseEventsSection
        v-if="upstreamSse?.length"
        :events="upstreamSse"
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
