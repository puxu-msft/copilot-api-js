<script setup lang="ts">
import { computed } from "vue"

import LineNumberPre from "@/components/ui/LineNumberPre.vue"
import { useContentContext } from "@/composables/useContentContext"
import { useHighlightHtml } from "@/composables/useHighlightHtml"

import ContentBlockWrapper from "./ContentBlockWrapper.vue"

const props = defineProps<{
  text: string
}>()

const { searchQuery } = useContentContext()

const summary = computed(() => (props.text.length > 60 ? props.text.slice(0, 60) + "..." : props.text))

const { displayHtml } = useHighlightHtml(() => props.text, searchQuery)
</script>

<template>
  <ContentBlockWrapper
    label="TEXT"
    label-color="text-muted"
    :summary="summary"
    :copy-text="text"
    :raw-data="{ type: 'text', text }"
    raw-title="Raw — text"
  >
    <LineNumberPre :html="displayHtml" />
  </ContentBlockWrapper>
</template>
