<script setup lang="ts">
import { computed } from 'vue'
import ContentBlockWrapper from './ContentBlockWrapper.vue'
import { useContentContext } from '@/composables/useContentContext'
import { useHighlightHtml } from '@/composables/useHighlightHtml'

const props = defineProps<{
  text: string
}>()

const { searchQuery } = useContentContext()

const summary = computed(() =>
  props.text.length > 60 ? props.text.slice(0, 60) + '...' : props.text
)

const { displayHtml } = useHighlightHtml(
  () => props.text,
  searchQuery,
)
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
    <pre class="text-content" v-html="displayHtml" />
  </ContentBlockWrapper>
</template>

<style scoped>
.text-content {
  font-size: var(--font-size-sm);
  color: var(--text);
  line-height: 1.6;
  white-space: pre-wrap;
  word-wrap: break-word;
}

:deep(.search-highlight) {
  background: var(--warning);
  color: var(--bg);
  padding: 0 2px;
}
</style>
