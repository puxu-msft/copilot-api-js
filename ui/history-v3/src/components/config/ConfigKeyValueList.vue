<script setup lang="ts">
import type { KeyValueEntry } from "@/types/config"

const props = defineProps<{
  modelValue: Array<KeyValueEntry>
  label: string
  description?: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  "update:modelValue": [value: Array<KeyValueEntry>]
}>()

function updateEntry(index: number, patch: Partial<KeyValueEntry>): void {
  emit(
    "update:modelValue",
    props.modelValue.map((entry, entryIndex) => (entryIndex === index ? { ...entry, ...patch } : entry)),
  )
}

function removeEntry(index: number): void {
  emit(
    "update:modelValue",
    props.modelValue.filter((_, entryIndex) => entryIndex !== index),
  )
}

function addEntry(): void {
  emit("update:modelValue", [...props.modelValue, { key: "", value: "" }])
}

function duplicateKey(index: number): boolean {
  const key = props.modelValue[index]?.key.trim()
  if (!key) return false
  return props.modelValue.some((entry, entryIndex) => entryIndex !== index && entry.key.trim() === key)
}
</script>

<template>
  <div class="d-flex flex-column ga-3">
    <div>
      <div class="text-body-1">{{ label }}</div>
      <div
        v-if="description"
        class="text-body-2 text-medium-emphasis mt-1"
      >
        {{ description }}
      </div>
    </div>

    <div
      v-if="modelValue.length === 0"
      class="text-body-2 text-medium-emphasis"
    >
      No overrides configured.
    </div>

    <div
      v-for="(entry, index) in modelValue"
      :key="index"
      class="d-flex align-start ga-3"
    >
      <v-text-field
        :model-value="entry.key"
        :disabled="disabled"
        :error="duplicateKey(index)"
        error-messages=""
        label="Source model"
        @update:model-value="updateEntry(index, { key: String($event ?? '') })"
      />
      <v-text-field
        :model-value="entry.value"
        :disabled="disabled"
        label="Target model"
        @update:model-value="updateEntry(index, { value: String($event ?? '') })"
      />
      <v-btn
        :disabled="disabled"
        icon="mdi-close"
        size="small"
        variant="text"
        @click="removeEntry(index)"
      />
    </div>

    <template
      v-for="(entry, index) in modelValue"
      :key="`error-${index}`"
    >
      <div
        v-if="duplicateKey(index)"
        class="text-caption text-error"
      >
        Duplicate key: {{ entry.key }}
      </div>
    </template>

    <div>
      <v-btn
        :disabled="disabled"
        prepend-icon="mdi-plus"
        variant="outlined"
        @click="addEntry"
      >
        Add override
      </v-btn>
    </div>
  </div>
</template>
