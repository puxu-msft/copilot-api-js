<script setup lang="ts">
import { computed } from "vue"

import type {
  //
  HistoryEntry,
  MessageContent,
} from "@/types"

import { resolveHeaders } from "@/composables/entry-legs"

import DetailRequestSection from "../DetailRequestSection.vue"
import HeadersComparisonSection from "../HeadersComparisonSection.vue"

// Inbound = client→proxy original request. Always shows the ORIGINAL messages
// (view mode forced "original"); rewritten messages expose a "↔ effective" jump
// + "diff" action (via MessageBlock → useMessageActions). HTTP headers first.
const props = defineProps<{
  entry: HistoryEntry
  requestBadge: string
  rewrittenRequest?: unknown
  filteredMessages: Array<{ msg: MessageContent; originalIndex: number }>
  truncationPoint: number | null
  searchQuery: string
  detailFilterType: string
  hasMatchingBlockType: (msg: MessageContent, filterType: string) => boolean
  isMessageTruncated: (index: number) => boolean
  isMessageRewritten: (index: number) => boolean
  getRewrittenMessage: (index: number) => MessageContent | null
}>()

// New `clientRequest.headers` ?? legacy `httpHeaders.inboundRequest` (P4c: drop legacy arm in entry-legs).
const inboundHeaders = computed(() => resolveHeaders(props.entry).inboundRequest)
</script>

<template>
  <div class="stage-inbound">
    <HeadersComparisonSection
      v-if="inboundHeaders"
      :inbound-request="inboundHeaders"
    />
    <DetailRequestSection
      :entry="entry"
      title="Inbound Request"
      :request-badge="requestBadge"
      :rewritten-request="rewrittenRequest"
      :filtered-messages="filteredMessages"
      :truncation-point="truncationPoint"
      :search-query="searchQuery"
      :detail-filter-type="detailFilterType"
      detail-view-mode="original"
      :has-matching-block-type="hasMatchingBlockType"
      :is-message-truncated="isMessageTruncated"
      :is-message-rewritten="isMessageRewritten"
      :get-rewritten-message="getRewrittenMessage"
    />
  </div>
</template>

<style scoped>
.stage-inbound {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
