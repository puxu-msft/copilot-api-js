<script setup lang="ts">
defineProps<{
  modelValue: boolean
  label?: string
}>()

defineEmits<{
  "update:modelValue": [value: boolean]
}>()
</script>

<template>
  <label class="base-checkbox">
    <input
      type="checkbox"
      :checked="modelValue"
      @change="$emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    />
    <span
      v-if="label"
      class="checkbox-label"
      >{{ label }}</span
    >
  </label>
</template>

<style scoped>
.base-checkbox {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  cursor: pointer;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  user-select: none;
}

.base-checkbox input[type="checkbox"] {
  appearance: none;
  width: 14px;
  height: 14px;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--bg-tertiary);
  cursor: pointer;
  position: relative;
  flex-shrink: 0;
}

.base-checkbox input[type="checkbox"]:checked {
  background: var(--primary);
  border-color: var(--primary);
}

.base-checkbox input[type="checkbox"]:checked::after {
  content: "";
  position: absolute;
  left: 4px;
  top: 1px;
  width: 4px;
  height: 8px;
  border: solid var(--primary-contrast);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

.checkbox-label {
  white-space: nowrap;
}
</style>
