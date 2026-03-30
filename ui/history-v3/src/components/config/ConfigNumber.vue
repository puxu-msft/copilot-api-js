<script setup lang="ts">
import { computed } from "vue"

const props = defineProps<{
  modelValue: number | null | undefined
  label: string
  description?: string
  disabled?: boolean
  suffix?: string
  min?: number
  max?: number
}>()

const emit = defineEmits<{
  "update:modelValue": [value: number | null]
}>()

const inputValue = computed({
  get: () => (props.modelValue == null ? "" : String(props.modelValue)),
  set: (value: string) => {
    if (value.trim().length === 0) {
      emit("update:modelValue", null)
      return
    }

    const next = Number(value)
    emit("update:modelValue", Number.isFinite(next) ? next : null)
  },
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

    <v-text-field
      v-model="inputValue"
      :disabled="disabled"
      :min="min"
      :max="max"
      :suffix="suffix"
      class="field-input"
      type="number"
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
  max-width: 180px;
}
</style>
