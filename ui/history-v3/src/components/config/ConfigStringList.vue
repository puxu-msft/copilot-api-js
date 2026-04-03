<script setup lang="ts">
const props = defineProps<{
  modelValue: Array<string>
  label: string
  description?: string
  disabled?: boolean
  itemLabel?: string
  emptyText?: string
}>()

const emit = defineEmits<{
  "update:modelValue": [value: Array<string>]
}>()

function updateEntry(index: number, value: string): void {
  emit(
    "update:modelValue",
    props.modelValue.map((entry, entryIndex) => (entryIndex === index ? value : entry)),
  )
}

function removeEntry(index: number): void {
  emit(
    "update:modelValue",
    props.modelValue.filter((_, entryIndex) => entryIndex !== index),
  )
}

function addEntry(): void {
  emit("update:modelValue", [...props.modelValue, ""])
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
      {{ emptyText ?? "No values configured." }}
    </div>

    <div
      v-for="(entry, index) in modelValue"
      :key="index"
      class="d-flex align-start ga-3"
    >
      <v-text-field
        :model-value="entry"
        :disabled="disabled"
        :label="itemLabel ?? 'Value'"
        @update:model-value="updateEntry(index, String($event ?? ''))"
      />
      <v-btn
        :disabled="disabled"
        icon="mdi-close"
        size="small"
        variant="text"
        :aria-label="`Remove ${itemLabel ?? 'item'} ${index + 1}`"
        @click="removeEntry(index)"
      />
    </div>

    <div>
      <v-btn
        :disabled="disabled"
        prepend-icon="mdi-plus"
        variant="outlined"
        @click="addEntry"
      >
        Add item
      </v-btn>
    </div>
  </div>
</template>
