<script setup lang="ts">
import { computed } from "vue"

import type {
  //
  HistoryEntry,
  MessageContent,
} from "@/types"

import DetailRequestSection from "../DetailRequestSection.vue"

// Effective = the request AFTER sanitize/truncate/rewrite (still the logical
// message model, before wire reformatting). Shows the REWRITTEN messages (view
// mode forced "rewritten"); rewritten messages expose a "↔ inbound" jump + "diff".
//
// Truncated messages are removed from the effective request, so they are dropped
// from this view (unlike the Inbound tab which shows the full original set).
// Messages SPLIT OFF a turn during rewrite (e.g. the user tool_result a
// downgraded web_search turn produces) ARE surfaced here — rendered read-only
// right after their source message via `getSplitMessages`. OTHER kinds of
// effective-only injected messages (if any arise in the future) are still not
// keyed off inbound indices and remain visible only via the Wire stage / Raw.
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
  getSplitMessages: (index: number) => Array<MessageContent>
}>()

const effectiveMessages = computed(() => props.filteredMessages.filter((m) => !props.isMessageTruncated(m.originalIndex)))
</script>

<template>
  <DetailRequestSection
    :entry="entry"
    title="Effective Request"
    :request-badge="requestBadge"
    :rewritten-request="rewrittenRequest"
    :filtered-messages="effectiveMessages"
    :truncation-point="truncationPoint"
    :search-query="searchQuery"
    :detail-filter-type="detailFilterType"
    detail-view-mode="rewritten"
    :has-matching-block-type="hasMatchingBlockType"
    :is-message-truncated="isMessageTruncated"
    :is-message-rewritten="isMessageRewritten"
    :get-rewritten-message="getRewrittenMessage"
    :get-split-messages="getSplitMessages"
  />
</template>
