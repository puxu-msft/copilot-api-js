<script setup lang="ts">
/**
 * Lightweight line-numbered text display.
 *
 * Renders pre-formatted text with a line-number gutter using CSS counters.
 * Supports v-html content (e.g. search-highlighted text). No external
 * dependencies — pure CSS implementation.
 */

import { computed } from "vue"

const props = defineProps<{
  /** HTML content to render (may include search highlights) */
  html: string
}>()

/** Split HTML by newlines, wrapping each line in a numbered span */
const lines = computed(() => {
  // Split on newlines. The html may contain <mark> or <span> tags for
  // search highlighting — these never span across newlines, so splitting
  // on \n is safe.
  return props.html.split("\n")
})
</script>

<template>
  <div class="line-number-pre">
    <div
      v-for="(line, i) in lines"
      :key="i"
      class="line"
    >
      <span class="line-no">{{ i + 1 }}</span>
      <span
        class="line-content"
        v-html="line || '&#8203;'"
      />
    </div>
  </div>
</template>

<style scoped>
.line-number-pre {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  line-height: 1.6;
  overflow-x: auto;
}

.line {
  display: flex;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.line:hover {
  background: var(--bg-hover);
}

.line-no {
  flex-shrink: 0;
  width: 3.5em;
  padding-right: 1em;
  text-align: right;
  color: var(--text-dim);
  user-select: none;
  opacity: 0.5;
}

.line-content {
  flex: 1;
  min-width: 0;
  color: var(--text);
}

:deep(.search-highlight) {
  background: var(--warning);
  color: var(--bg);
  padding: 0 2px;
}
</style>
