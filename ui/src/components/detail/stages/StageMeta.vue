<script setup lang="ts">
import type { HistoryEntry } from "@/types"

import ErrorBoundary from "@/components/ui/ErrorBoundary.vue"

import MetaInfo from "../MetaInfo.vue"
import SectionBlock from "../SectionBlock.vue"

defineProps<{ entry: HistoryEntry }>()
</script>

<template>
  <SectionBlock
    title="Meta"
    anchor="meta"
    :raw-data="entry"
    raw-title="Entry"
  >
    <ErrorBoundary label="Meta info">
      <MetaInfo :entry="entry" />
    </ErrorBoundary>
  </SectionBlock>
</template>
