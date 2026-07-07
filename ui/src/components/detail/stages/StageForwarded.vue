<script setup lang="ts">
import { computed } from "vue"

import type { HistoryEntry } from "@/types"

import ErrorBoundary from "@/components/ui/ErrorBoundary.vue"
import {
  //
  resolveForwardedContent,
  resolveForwardedSse,
  resolveUpstreamSse,
} from "@/composables/entry-legs"

import SectionBlock from "../SectionBlock.vue"
import SseEventsSection from "../SseEventsSection.vue"
import SseFrameDiff from "../SseFrameDiff.vue"

const props = defineProps<{ entry: HistoryEntry }>()

// New `clientResponse` / final-attempt `upstreamResponse` (legacy `inboundResponse`/`sseEvents` removed in P4c).
const upstreamSse = computed(() => resolveUpstreamSse(props.entry))
const forwardedSse = computed(() => resolveForwardedSse(props.entry))
const forwardedContent = computed(() => resolveForwardedContent(props.entry))
</script>

<template>
  <div class="stage-forwarded">
    <!-- Upstream-vs-client aligned frame diff (the actionable "what changed"). -->
    <ErrorBoundary label="SSE frame diff">
      <SseFrameDiff
        v-if="upstreamSse?.length && forwardedSse?.length"
        :upstream="upstreamSse"
        :forwarded="forwardedSse"
      />
    </ErrorBoundary>

    <ErrorBoundary label="Forwarded SSE events">
      <SseEventsSection
        v-if="forwardedSse?.length"
        :events="forwardedSse"
        title="SSE Events (proxy → client)"
      />
    </ErrorBoundary>

    <ErrorBoundary label="Forwarded response">
      <SectionBlock
        v-if="forwardedContent != null"
        title="Forwarded Response (proxy → client)"
        anchor="forwarded"
        :raw-data="forwardedContent"
        raw-title="Forwarded Response"
      >
        <pre class="stage-json">{{ JSON.stringify(forwardedContent, null, 2) }}</pre>
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
