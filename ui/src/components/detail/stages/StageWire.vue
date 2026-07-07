<script setup lang="ts">
import { computed } from "vue"

import type { HistoryEntry } from "@/types"

import ErrorBoundary from "@/components/ui/ErrorBoundary.vue"
import {
  //
  resolveHeaders,
  resolveWirePayload,
} from "@/composables/entry-legs"

import HeadersComparisonSection from "../HeadersComparisonSection.vue"
import SectionBlock from "../SectionBlock.vue"

const props = defineProps<{ entry: HistoryEntry }>()

// New final-attempt `upstreamRequest` ?? legacy `outboundRequest`/`httpHeaders` (P4c: drop legacy arms in entry-legs).
const outboundHeaders = computed(() => resolveHeaders(props.entry).outboundRequest)
const wirePayload = computed(() => resolveWirePayload(props.entry))
</script>

<template>
  <div class="stage-wire">
    <!-- HTTP headers first, then the real wire body sent upstream. -->
    <HeadersComparisonSection
      v-if="outboundHeaders"
      :outbound-request="outboundHeaders"
    />
    <ErrorBoundary label="Outbound wire request">
      <SectionBlock
        v-if="wirePayload != null"
        title="Outbound Wire Request (proxy → upstream)"
        anchor="outbound-wire"
        :raw-data="wirePayload"
        raw-title="Outbound wire payload"
      >
        <pre class="stage-json">{{ JSON.stringify(wirePayload, null, 2) }}</pre>
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
