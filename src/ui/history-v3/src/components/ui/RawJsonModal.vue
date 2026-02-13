<script setup lang="ts">
import { computed } from 'vue'
import BaseModal from './BaseModal.vue'
import IconSvg from './IconSvg.vue'
import { useCopyToClipboard } from '@/composables/useCopyToClipboard'
import VueJsonPretty from 'vue-json-pretty'
import 'vue-json-pretty/lib/styles.css'

const props = defineProps<{
  visible: boolean
  title: string
  data: unknown
}>()

defineEmits<{
  'update:visible': [value: boolean]
}>()

const { copy } = useCopyToClipboard()

const jsonText = computed(() => {
  try {
    return JSON.stringify(props.data, null, 2)
  } catch {
    return String(props.data)
  }
})

function copyJson() {
  copy(jsonText.value)
}
</script>

<template>
  <BaseModal
    :visible="visible"
    :title="title"
    width="95vw"
    height="95vh"
    @update:visible="$emit('update:visible', $event)"
  >
    <template #header-actions>
      <button class="raw-copy-btn" title="Copy JSON" @click="copyJson">
        <IconSvg name="copy" :size="12" />
        Copy
      </button>
    </template>
    <div class="json-viewer">
      <VueJsonPretty
        :data="(data as any)"
        :deep="Infinity"
        :show-line-number="true"
        :show-icon="true"
        :collapsed-on-click-brackets="true"
      />
    </div>
  </BaseModal>
</template>

<style scoped>
.raw-copy-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  padding: 4px 8px;
  background: transparent;
}

.raw-copy-btn:hover {
  color: var(--text);
  background: var(--bg-hover);
}

.json-viewer {
  overflow: auto;
}

/* Dark theme overrides for vue-json-pretty */
:deep(.vjs-tree) {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  background: transparent !important;
  color: var(--text) !important;
}

:deep(.vjs-tree-node:hover) {
  background: var(--bg-hover) !important;
}

:deep(.vjs-key) {
  color: var(--cyan) !important;
}

:deep(.vjs-value-string) {
  color: var(--success) !important;
}

:deep(.vjs-value-number) {
  color: var(--warning) !important;
}

:deep(.vjs-value-boolean) {
  color: var(--purple) !important;
}

:deep(.vjs-value-null) {
  color: var(--text-dim) !important;
}

:deep(.vjs-tree__brackets) {
  color: var(--text-muted) !important;
}

:deep(.vjs-tree__brackets:hover) {
  color: var(--primary) !important;
  cursor: pointer;
}

:deep(.vjs-tree__content.has-line) {
  border-left: 1px solid var(--border-light) !important;
}

:deep(.vjs-tree__indent--line-number) {
  color: var(--text-dim) !important;
  border-right: 1px solid var(--border-light) !important;
}
</style>
