<script setup lang="ts">
defineProps<{
  rawApiResponse: unknown
}>()
</script>

<template>
  <div class="flex-grow-1 overflow-y-auto pa-4">
    <pre class="text-caption mono raw-pre">{{ JSON.stringify(rawApiResponse, null, 2) }}</pre>
  </div>
</template>

<style scoped>
.mono {
  font-family: "SF Mono", Monaco, "Courier New", monospace;
}

.raw-pre {
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
