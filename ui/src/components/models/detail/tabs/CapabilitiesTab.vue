<script setup lang="ts">
import type { DerivedCapabilities } from "~backend/lib/models/capabilities"
import type { Model } from "~backend/lib/models/client"

import { computed } from "vue"

import DetailSection from "../DetailSection.vue"

const props = defineProps<{ model: Model; caps: DerivedCapabilities }>()

const derivedRows = computed<Array<[string, boolean]>>(() => [
  ["Vision", props.caps.vision],
  ["Tool calls", props.caps.toolCalls],
  ["Parallel tools", props.caps.parallelToolCalls],
  ["Structured outputs", props.caps.structuredOutputs],
  ["Streaming", props.caps.streaming],
  ["Thinking", props.caps.thinking],
])

const thinkingDetail = computed(() => {
  if (!props.caps.thinking) return null
  if (props.caps.maxThinkingBudget > 0) return `budget ≤ ${props.caps.maxThinkingBudget}`
  return props.caps.adaptiveThinking ? "adaptive" : null
})

/** Full raw supports map — NOT trimmed to the derived subset (richest-data-flow). */
const supportsRows = computed<Array<[string, string]>>(() =>
  Object.entries(props.model.capabilities?.supports ?? {}).map(([key, value]) => [key, Array.isArray(value) ? value.join("/") : String(value)]),
)
</script>

<template>
  <div>
    <DetailSection title="Capabilities">
      <div
        v-for="[label, on] in derivedRows"
        :key="label"
        class="cap-row"
      >
        <span
          class="cap-mark"
          :class="on ? 'yes' : 'no'"
          >{{ on ? "✓" : "·" }}</span
        >
        <span>{{ label }}</span>
        <span
          v-if="label === 'Thinking' && thinkingDetail"
          class="cap-detail"
          >{{ thinkingDetail }}</span
        >
      </div>
    </DetailSection>
    <DetailSection title="Supports (raw)">
      <div
        v-if="supportsRows.length === 0"
        class="text-medium-emphasis text-caption"
      >
        —
      </div>
      <div
        v-for="[key, value] in supportsRows"
        :key="key"
        class="supports-row"
      >
        <span class="supports-key">{{ key }}</span>
        <span class="supports-value font-mono">{{ value }}</span>
      </div>
    </DetailSection>
  </div>
</template>

<style scoped>
.cap-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 0.83rem;
}

.cap-mark.yes {
  color: rgb(var(--v-theme-success));
  font-weight: 700;
}

.cap-mark.no {
  color: rgb(var(--v-theme-surface-variant));
}

.cap-detail {
  color: rgb(var(--v-theme-secondary));
  font-size: 0.74rem;
}

.supports-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: baseline;
}

.supports-key {
  font-size: 0.74rem;
  letter-spacing: 0.04em;
  color: rgb(var(--v-theme-secondary));
}

.supports-value {
  font-size: 0.83rem;
  font-variant-numeric: tabular-nums;
  text-align: right;
  word-break: break-word;
}
</style>
