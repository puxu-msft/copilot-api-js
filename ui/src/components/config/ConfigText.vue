<script setup lang="ts">
import { computed } from "vue"

const props = defineProps<{
  modelValue: string | null | undefined
  label: string
  description?: string
  disabled?: boolean
  multiline?: boolean
  placeholder?: string
}>()

const emit = defineEmits<{
  "update:modelValue": [value: string | null]
}>()

const textValue = computed({
  get: () => props.modelValue ?? "",
  set: (value: string) => emit("update:modelValue", value.length === 0 ? null : value),
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

    <v-textarea
      v-if="multiline"
      v-model="textValue"
      :disabled="disabled"
      :placeholder="placeholder"
      auto-grow
      class="field-input"
      rows="3"
      variant="outlined"
    />

    <v-text-field
      v-else
      v-model="textValue"
      :disabled="disabled"
      :placeholder="placeholder"
      class="field-input"
      clearable
    />
  </div>
</template>

<style scoped>
.config-field {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.field-copy {
  min-width: 0;
  flex: 1;
}

.field-input {
  flex: 1;
  max-width: 560px;
}
</style>
