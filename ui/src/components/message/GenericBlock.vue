<script setup lang="ts">
import { computed } from "vue"

import type { ContentBlock } from "@/types"

import ContentBlockWrapper from "./ContentBlockWrapper.vue"

const props = defineProps<{
  block: ContentBlock
}>()

const label = computed(() => (props.block.type || "UNKNOWN").toUpperCase())

const json = computed(() => {
  try {
    return JSON.stringify(props.block, null, 2)
  } catch {
    return String(props.block)
  }
})
</script>

<template>
  <ContentBlockWrapper
    :label="label"
    label-color="text-muted"
    :summary="block.type || 'unknown'"
    :raw-data="block"
    :raw-title="'Raw — ' + (block.type || 'unknown')"
  >
    <pre class="generic-content">{{ json }}</pre>
  </ContentBlockWrapper>
</template>

<style scoped>
.generic-content {
  font-size: var(--font-size-sm);
  color: var(--text-muted);
}
</style>
