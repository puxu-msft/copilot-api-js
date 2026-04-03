<script setup lang="ts">
import JsonViewerSurface from "@/components/ui/JsonViewerSurface.vue"

defineProps<{
  rawApiResponse: unknown
}>()
</script>

<template>
  <JsonViewerSurface
    :data="rawApiResponse"
    copy-message="Models JSON copied"
    class="raw-view"
  />
</template>

<style scoped>
.raw-view {
  min-height: 0;
}
</style>
