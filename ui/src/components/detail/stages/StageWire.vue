<script setup lang="ts">
import type { HistoryEntry } from "@/types"

import ErrorBoundary from "@/components/ui/ErrorBoundary.vue"

import HeadersComparisonSection from "../HeadersComparisonSection.vue"
import SectionBlock from "../SectionBlock.vue"

defineProps<{ entry: HistoryEntry }>()
</script>

<template>
  <div class="stage-wire">
    <!-- HTTP headers first, then the real wire body sent upstream. -->
    <HeadersComparisonSection
      v-if="entry.httpHeaders?.outboundRequest"
      :outbound-request="entry.httpHeaders.outboundRequest"
    />
    <ErrorBoundary label="Outbound wire request">
      <SectionBlock
        v-if="entry.outboundRequest?.payload != null"
        title="Outbound Wire Request (proxy → upstream)"
        anchor="outbound-wire"
        :raw-data="entry.outboundRequest.payload"
        raw-title="Outbound wire payload"
      >
        <pre class="stage-json">{{ JSON.stringify(entry.outboundRequest.payload, null, 2) }}</pre>
      </SectionBlock>
      <div
        v-else
        class="stage-empty text-caption text-medium-emphasis"
      >
        No outbound wire request body recorded.
      </div>
    </ErrorBoundary>
  </div>
</template>

<style scoped>
.stage-wire {
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

.stage-empty {
  padding: 8px;
}
</style>
