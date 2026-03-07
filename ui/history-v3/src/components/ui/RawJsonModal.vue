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
  rewrittenData?: unknown
}>()

defineEmits<{
  'update:visible': [value: boolean]
}>()

const { copy } = useCopyToClipboard()

/** Whether to show split Original / Rewritten view */
const hasSplit = computed(() => props.rewrittenData != null)

const jsonText = computed(() => {
  try {
    return JSON.stringify(props.data, null, 2)
  } catch {
    return String(props.data)
  }
})

const rewrittenJsonText = computed(() => {
  if (!props.rewrittenData) return ''
  try {
    return JSON.stringify(props.rewrittenData, null, 2)
  } catch {
    return String(props.rewrittenData)
  }
})

function copyJson() {
  copy(jsonText.value)
}

function copyRewrittenJson() {
  copy(rewrittenJsonText.value)
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
      <!-- Single view: one copy button -->
      <button v-if="!hasSplit" class="raw-copy-btn" title="Copy JSON" @click="copyJson">
        <IconSvg name="copy" :size="12" />
        Copy
      </button>
    </template>

    <!-- Split view: Original / Rewritten side by side -->
    <div v-if="hasSplit" class="json-split">
      <div class="json-pane">
        <div class="pane-header">
          <span class="pane-label">Original</span>
          <button class="raw-copy-btn" title="Copy original JSON" @click="copyJson">
            <IconSvg name="copy" :size="12" />
            Copy
          </button>
        </div>
        <div class="json-viewer">
          <VueJsonPretty
            :data="(data as any)"
            :deep="5"
            :show-line-number="true"
            :show-icon="true"
            :show-length="true"
            :collapsed-on-click-brackets="true"
          />
        </div>
      </div>
      <div class="pane-divider" />
      <div class="json-pane">
        <div class="pane-header">
          <span class="pane-label pane-label-rewritten">Rewritten</span>
          <button class="raw-copy-btn" title="Copy rewritten JSON" @click="copyRewrittenJson">
            <IconSvg name="copy" :size="12" />
            Copy
          </button>
        </div>
        <div class="json-viewer">
          <VueJsonPretty
            :data="(rewrittenData as any)"
            :deep="5"
            :show-line-number="true"
            :show-icon="true"
            :show-length="true"
            :collapsed-on-click-brackets="true"
          />
        </div>
      </div>
    </div>

    <!-- Single view (no rewrites) -->
    <div v-else class="json-viewer">
      <VueJsonPretty
        :data="(data as any)"
        :deep="5"
        :show-line-number="true"
        :show-icon="true"
        :show-length="true"
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

/* ─── Split view ─── */

.json-split {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.json-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.json-pane .json-viewer {
  flex: 1;
  overflow: auto;
}

.pane-divider {
  width: 1px;
  background: var(--border-light);
  flex-shrink: 0;
}

.pane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-xs) var(--spacing-sm);
  border-bottom: 1px solid var(--border-light);
  background: var(--bg-tertiary);
  flex-shrink: 0;
}

.pane-label {
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
}

.pane-label-rewritten {
  color: var(--warning);
}

/* ─── Dark theme overrides for vue-json-pretty ─── */

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
