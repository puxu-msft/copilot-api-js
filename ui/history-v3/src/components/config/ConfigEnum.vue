<script setup lang="ts">
defineProps<{
  modelValue: string | boolean | null | undefined
  label: string
  description?: string
  disabled?: boolean
  options: Array<{ value: string | boolean; label: string }>
}>()

const emit = defineEmits<{
  "update:modelValue": [value: string | boolean]
}>()
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

    <v-btn-toggle
      :model-value="modelValue"
      :disabled="disabled"
      color="primary"
      divided
      mandatory
      @update:model-value="$event != null && emit('update:modelValue', $event)"
    >
      <v-btn
        v-for="option in options"
        :key="String(option.value)"
        :value="option.value"
      >
        {{ option.label }}
      </v-btn>
    </v-btn-toggle>
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
</style>
