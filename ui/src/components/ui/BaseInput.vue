<script setup lang="ts">
import { ref } from "vue"

import IconSvg from "./IconSvg.vue"

defineProps<{
  modelValue: string
  placeholder?: string
  icon?: string
}>()

defineEmits<{
  "update:modelValue": [value: string]
}>()

const inputRef = ref<HTMLInputElement>()

function focus() {
  inputRef.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <div
    class="base-input"
    :class="{ 'has-icon': icon }"
  >
    <IconSvg
      v-if="icon"
      :name="icon"
      :size="13"
      class="input-icon"
    />
    <input
      ref="inputRef"
      type="text"
      :value="modelValue"
      :placeholder="placeholder"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
  </div>
</template>

<style scoped>
.base-input {
  position: relative;
  display: flex;
  align-items: center;
}

.base-input input {
  width: 100%;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--border-radius-sm);
  padding: 4px 8px;
  font-size: var(--font-size-xs);
  color: var(--text);
  outline: none;
}

.base-input input:focus {
  border-color: var(--primary);
}

.base-input input::placeholder {
  color: var(--text-dim);
}

.has-icon input {
  padding-left: 26px;
}

.input-icon {
  position: absolute;
  left: 8px;
  color: var(--text-dim);
  pointer-events: none;
}
</style>
