<script setup lang="ts">
import { computed } from "vue"

import type {
  //
  HistoryEntry,
  MessageContent,
} from "@/types"

import MessageBlock from "@/components/message/MessageBlock.vue"
import SystemMessage from "@/components/message/SystemMessage.vue"
import ErrorBoundary from "@/components/ui/ErrorBoundary.vue"

import SectionBlock from "./SectionBlock.vue"
import TruncationDivider from "./TruncationDivider.vue"

const props = defineProps<{
  entry: HistoryEntry
  requestBadge: string
  rewrittenRequest?: unknown
  filteredMessages: Array<{ msg: MessageContent; originalIndex: number }>
  truncationPoint: number | null
  searchQuery: string
  detailFilterType: string
  detailViewMode: "original" | "rewritten" | "diff" | null
  hasMatchingBlockType: (msg: MessageContent, filterType: string) => boolean
  isMessageTruncated: (index: number) => boolean
  isMessageRewritten: (index: number) => boolean
  getRewrittenMessage: (index: number) => MessageContent | null
}>()

/** Only expand the last 5 messages by default — older messages start collapsed */
const EXPAND_RECENT_COUNT = 5

const collapseThreshold = computed(() => {
  const total = props.filteredMessages.length
  return total > EXPAND_RECENT_COUNT ? total - EXPAND_RECENT_COUNT : 0
})
</script>

<template>
  <SectionBlock
    title="Request"
    anchor="request"
    :badge="requestBadge"
    :raw-data="entry.request"
    :rewritten-raw-data="rewrittenRequest"
    raw-title="Request"
  >
    <ErrorBoundary label="System prompt">
      <SystemMessage
        v-if="entry.request.system"
        :system="entry.request.system"
        :rewritten-system="entry.effectiveRequest?.system"
        :search-query="searchQuery"
        :global-view-mode="detailViewMode"
      />
    </ErrorBoundary>

    <div class="messages-list">
      <template
        v-for="(item, listIndex) in filteredMessages"
        :key="item.originalIndex"
      >
        <TruncationDivider
          v-if="entry.pipelineInfo?.truncation && item.originalIndex === truncationPoint"
          :truncation="entry.pipelineInfo.truncation"
        />

        <ErrorBoundary :label="'Message #' + item.originalIndex">
          <MessageBlock
            v-show="!detailFilterType || hasMatchingBlockType(item.msg, detailFilterType)"
            :message="item.msg"
            :index="item.originalIndex"
            :is-truncated="isMessageTruncated(item.originalIndex)"
            :is-rewritten="isMessageRewritten(item.originalIndex)"
            :rewritten-message="getRewrittenMessage(item.originalIndex)"
            :global-view-mode="detailViewMode"
            :default-collapsed="listIndex < collapseThreshold"
          />
        </ErrorBoundary>
      </template>
    </div>
  </SectionBlock>
</template>

<style scoped>
.messages-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}
</style>
