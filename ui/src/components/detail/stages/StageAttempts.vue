<script setup lang="ts">
import type { HistoryEntry } from "@/types"

import AttemptDiff from "../AttemptDiff.vue"
import AttemptsTimeline from "../AttemptsTimeline.vue"
import SectionBlock from "../SectionBlock.vue"

defineProps<{ entry: HistoryEntry }>()
</script>

<template>
  <SectionBlock
    v-if="entry.attempts && entry.attempts.length > 1"
    title="Retry Timeline"
    anchor="attempts"
  >
    <AttemptsTimeline :attempts="entry.attempts" />
    <!-- Per-retry sent-payload diff (Bug3): what each attempt changed upstream. -->
    <div class="mt-3">
      <AttemptDiff :attempts="entry.attempts" />
    </div>
  </SectionBlock>
  <div
    v-else
    class="stage-empty text-caption text-medium-emphasis"
  >
    Single attempt — no retries.
  </div>
</template>

<style scoped>
.stage-empty {
  padding: 8px;
}
</style>
