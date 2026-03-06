<script setup lang="ts">
import { computed } from 'vue'
import * as Diff from 'diff'
import { html as diff2html } from 'diff2html'

const props = withDefaults(defineProps<{
  oldText: string
  newText: string
  outputFormat?: 'side-by-side' | 'line-by-line'
}>(), {
  outputFormat: 'side-by-side',
})

const diffHtml = computed(() => {
  try {
    const patch = Diff.createTwoFilesPatch('original', 'rewritten', props.oldText, props.newText)
    return diff2html(patch, {
      outputFormat: props.outputFormat,
      drawFileList: false,
      matching: 'lines',
    })
  } catch {
    return '<pre>Diff generation failed</pre>'
  }
})
</script>

<template>
  <div class="diff-view" v-html="diffHtml" />
</template>

<style scoped>
.diff-view {
  overflow-x: auto;
  font-size: var(--font-size-sm);
}
</style>
