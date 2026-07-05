<script setup lang="ts">
import type { Model } from "~backend/lib/models/client"

import JsonViewerSurface from "@/components/ui/JsonViewerSurface.vue"

defineProps<{ model: Model }>()
</script>

<template>
  <JsonViewerSurface
    :data="model"
    :show-toolbar="false"
    fill-height
    class="raw-json-tab"
  />
</template>

<style scoped>
.raw-json-tab {
  min-height: 320px;
}
</style>
