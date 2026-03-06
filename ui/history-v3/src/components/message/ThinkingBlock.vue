<script setup lang="ts">
import { computed } from 'vue'
import ContentBlockWrapper from './ContentBlockWrapper.vue'
import { useContentContext } from '@/composables/useContentContext'
import { useHighlightHtml } from '@/composables/useHighlightHtml'

const props = withDefaults(defineProps<{
  text: string
  redacted?: boolean
}>(), {
  redacted: false,
})

const { searchQuery } = useContentContext()

const summary = computed(() => {
  if (props.redacted) return '[redacted]'
  return props.text.length > 60 ? props.text.slice(0, 60) + '...' : props.text
})

const { displayHtml } = useHighlightHtml(
  () => props.text,
  searchQuery,
)

const renderedHtml = computed(() => {
  if (props.redacted) return '<em>[Thinking content redacted]</em>'
  return displayHtml.value
})
</script>

<template>
  <ContentBlockWrapper
    label="THINKING"
    label-color="purple"
    :summary="summary"
    :copy-text="redacted ? undefined : text"
    :raw-data="redacted ? undefined : { type: 'thinking', thinking: text }"
    raw-title="Raw — thinking"
    :class="{ redacted }"
  >
    <template #header-extra>
      <span v-if="redacted" class="redacted-label">REDACTED</span>
    </template>
    <pre class="thinking-text" v-html="renderedHtml" />
  </ContentBlockWrapper>
</template>

<style scoped>
.redacted {
  opacity: 0.6;
}

.redacted-label {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  font-style: italic;
}

.thinking-text {
  font-size: var(--font-size-sm);
  color: var(--text);
  white-space: pre-wrap;
  word-wrap: break-word;
  line-height: 1.6;
}

:deep(.search-highlight) {
  background: var(--warning);
  color: var(--bg);
  padding: 0 2px;
}

:deep(.content-block) {
  border-color: rgba(163, 113, 247, 0.3);
}

:deep(.content-block-header) {
  background: var(--purple-muted);
}
</style>
