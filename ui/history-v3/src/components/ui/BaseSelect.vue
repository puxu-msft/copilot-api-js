<script setup lang="ts">
defineProps<{
  modelValue: string | null
  options: Array<{ value: string; label: string }>
  placeholder?: string
}>()

defineEmits<{
  "update:modelValue": [value: string | null]
}>()
</script>

<template>
  <select
    class="base-select"
    :value="modelValue ?? ''"
    @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value || null)"
  >
    <option
      v-if="placeholder"
      value=""
    >
      {{ placeholder }}
    </option>
    <option
      v-for="opt in options"
      :key="opt.value"
      :value="opt.value"
    >
      {{ opt.label }}
    </option>
  </select>
</template>

<style scoped>
.base-select {
  background: var(--bg-tertiary);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--border-radius-sm);
  padding: 4px 8px;
  font-size: var(--font-size-xs);
  cursor: pointer;
  outline: none;
  min-width: 80px;
  appearance: auto;
}
.base-select:focus {
  border-color: var(--primary);
}
.base-select:hover {
  border-color: var(--text-dim);
}
</style>
