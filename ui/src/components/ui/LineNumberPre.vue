<script setup lang="ts">
/**
 * Lightweight line-numbered text display.
 *
 * Renders pre-formatted text with a line-number gutter using CSS counters.
 * Supports v-html content (e.g. search-highlighted text). No external
 * dependencies — pure CSS implementation.
 *
 * Large texts (>500 lines) are truncated by default with a "Show all" button
 * to avoid creating thousands of DOM nodes on initial render.
 */

import {
  //
  computed,
  ref,
} from "vue"

const props = defineProps<{
  /** HTML content to render (may include search highlights) */
  html: string
}>()

const INITIAL_LINE_LIMIT = 500
const showAll = ref(false)

const allLines = computed(() => props.html.split("\n"))

const isTruncated = computed(() => !showAll.value && allLines.value.length > INITIAL_LINE_LIMIT)

const lines = computed(() => (isTruncated.value ? allLines.value.slice(0, INITIAL_LINE_LIMIT) : allLines.value))

const hiddenCount = computed(() => allLines.value.length - INITIAL_LINE_LIMIT)
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
    <div
      v-if="isTruncated"
      class="truncation-notice"
    >
      <button
        class="show-all-btn"
        @click="showAll = true"
      >
        {{ hiddenCount }} more lines — click to show all {{ allLines.length }} lines
      </button>
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

.truncation-notice {
  padding: var(--spacing-sm) 0;
  text-align: center;
  border-top: 1px dashed var(--border);
  margin-top: var(--spacing-xs);
}

.show-all-btn {
  font-size: var(--font-size-xs);
  color: var(--primary);
  background: none;
  border: none;
  cursor: pointer;
  padding: var(--spacing-xs) var(--spacing-sm);
}

.show-all-btn:hover {
  text-decoration: underline;
}

:deep(.search-highlight) {
  background: var(--warning);
  color: var(--bg);
  padding: 0 2px;
}
</style>
