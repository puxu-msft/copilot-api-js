<script setup lang="ts">
import { computed, useSlots } from "vue"
import VueJsonPretty from "vue-json-pretty"

import { useCopyToClipboard } from "@/composables/useCopyToClipboard"

import "vue-json-pretty/lib/styles.css"

const props = withDefaults(defineProps<{
  data: unknown
  copyMessage?: string
  copyLabel?: string
  deep?: number
  fillHeight?: boolean
  showToolbar?: boolean
}>(), {
  copyLabel: "Copy JSON",
  copyMessage: "JSON copied",
  deep: 5,
  fillHeight: false,
  showToolbar: true,
})

const { copy } = useCopyToClipboard()
const slots = useSlots()
const hasHeader = computed(() => Boolean(slots.header))

const jsonText = computed(() => {
  try {
    return JSON.stringify(props.data, null, 2)
  } catch {
    return String(props.data)
  }
})

function copyJson(): void {
  void copy(jsonText.value, props.copyMessage)
}
</script>

<template>
  <v-sheet
    class="json-viewer-shell"
    color="surface"
    border
  >
    <div v-if="showToolbar">
      <div
        class="json-viewer-toolbar"
        :class="{ 'json-viewer-toolbar-end': !hasHeader }"
      >
        <div
          v-if="hasHeader"
          class="json-viewer-toolbar-copy"
        >
          <slot name="header" />
        </div>

        <v-btn
          size="small"
          variant="outlined"
          @click="copyJson"
        >
          <v-icon
            start
            size="x-small"
            icon="mdi-content-copy"
          />
          {{ copyLabel }}
        </v-btn>
      </div>
    </div>

    <div
      class="json-viewer-frame"
      :class="{ 'json-viewer-frame-fill': fillHeight }"
    >
      <VueJsonPretty
        :data="data as any"
        :deep="deep"
        :show-line-number="true"
        :show-icon="true"
        :show-length="true"
        :collapsed-on-click-brackets="true"
      />
    </div>
  </v-sheet>
</template>

<style scoped>
.json-viewer-shell {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-color: rgb(var(--v-theme-surface-variant));
  background: rgb(var(--v-theme-surface));
  overflow: hidden;
}

.json-viewer-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border-bottom: 1px solid rgb(var(--v-theme-surface-variant));
}

.json-viewer-toolbar-end {
  justify-content: flex-end;
}

.json-viewer-toolbar-copy {
  min-width: 0;
}

.json-viewer-frame {
  max-height: 68vh;
  min-height: 0;
  overflow: auto;
  background: #0d1117;
}

.json-viewer-frame-fill {
  flex: 1;
  max-height: none;
}

@media (max-width: 700px) {
  .json-viewer-toolbar {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
