<script setup lang="ts">
import {
  //
  computed,
  ref,
} from "vue"

import type {
  //
  HistoryEntry,
  MessageContent,
} from "@/types"

import MessageDiffView from "@/components/detail/MessageDiffView.vue"

const props = defineProps<{ attempts: NonNullable<HistoryEntry["attempts"]> }>()

type Attempt = NonNullable<HistoryEntry["attempts"]>[number]

/** Wire-request messages for an attempt: new `upstreamRequest.messages` (legacy `wireRequest.messages` removed in P4c). */
function attemptMessages(a: Attempt): Array<MessageContent> | undefined {
  return a.upstreamRequest?.messages
}

// Only attempts that actually captured a wire request body can be diffed.
const withMessages = computed(() => props.attempts.filter((a) => (attemptMessages(a)?.length ?? 0) > 0))

// Consecutive transitions: #1→#2, #2→#3, … (what each retry changed in the sent payload).
const pairs = computed(() => {
  const list = withMessages.value
  return list.slice(1).map((to, i) => ({ from: list[i], to }))
})

// Default to the final transition (most often "what finally got truncated").
// null = follow the default (last); a number = explicit user pick.
const selected = ref<number | null>(null)
const activeIndex = computed(() => selected.value ?? Math.max(0, pairs.value.length - 1))
const activePair = computed(() => pairs.value[activeIndex.value])

function selectPair(i: number): void {
  selected.value = i
}
</script>

<template>
  <div
    v-if="pairs.length > 0 && activePair"
    class="attempt-diff"
  >
    <div class="attempt-diff-bar">
      <span class="attempt-diff-label text-caption text-medium-emphasis">Sent-payload change per retry:</span>
      <v-chip
        v-for="(pair, i) in pairs"
        :key="i"
        size="x-small"
        :variant="i === activeIndex ? 'flat' : 'tonal'"
        :color="i === activeIndex ? 'primary' : undefined"
        @click="selectPair(i)"
      >
        #{{ pair.from.index + 1 }}→#{{ pair.to.index + 1 }}
      </v-chip>
    </div>
    <MessageDiffView
      :left="attemptMessages(activePair.from)!"
      :right="attemptMessages(activePair.to)!"
    />
  </div>
  <div
    v-else
    class="text-caption text-medium-emphasis"
  >
    No per-attempt wire payloads captured to diff.
  </div>
</template>

<style scoped>
.attempt-diff {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.attempt-diff-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.attempt-diff-label {
  margin-right: 4px;
}
</style>
