<script setup lang="ts">
import { computed } from "vue"

import HistoryDetailSurface from "@/components/detail/HistoryDetailSurface.vue"

const props = defineProps<{
  modelValue: boolean
  title: string
  loading: boolean
  missingId: string | null
}>()

const emit = defineEmits<{
  "update:modelValue": [value: boolean]
}>()

const isOpen = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value),
})

function close(): void {
  isOpen.value = false
}
</script>

<template>
  <v-dialog
    v-model="isOpen"
    width="calc(100vw - 24px)"
    :transition="false"
    content-class="history-detail-dialog"
  >
    <HistoryDetailSurface
      :title="title"
      :loading="loading"
      :missing-id="missingId"
      @close="close"
    />
  </v-dialog>
</template>

<style scoped>
:deep(.history-detail-dialog) {
  width: calc(100vw - 24px);
  max-width: calc(100vw - 24px);
}
</style>
