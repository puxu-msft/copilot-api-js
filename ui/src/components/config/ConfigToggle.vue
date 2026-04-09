<script setup lang="ts">
import { computed } from "vue"

const props = defineProps<{
  modelValue: boolean | null | undefined
  label: string
  description?: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  "update:modelValue": [value: boolean]
}>()

const model = computed({
  get: () => props.modelValue ?? false,
  set: (value: boolean) => emit("update:modelValue", value),
})
</script>

<template>
  <div class="config-field">
    <div class="field-copy">
      <div class="text-body-1">{{ label }}</div>
      <div
        v-if="description"
        class="text-body-2 text-medium-emphasis mt-1"
      >
        {{ description }}
      </div>
    </div>

    <v-switch
      v-model="model"
      :disabled="disabled"
      color="primary"
      hide-details
      inset
    />
  </div>
</template>

<style scoped>
.config-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.field-copy {
  min-width: 0;
}
</style>
