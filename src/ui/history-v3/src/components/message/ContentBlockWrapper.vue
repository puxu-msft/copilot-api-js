<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import IconSvg from '@/components/ui/IconSvg.vue'
import RawJsonModal from '@/components/ui/RawJsonModal.vue'
import { useCopyToClipboard } from '@/composables/useCopyToClipboard'

const props = withDefaults(defineProps<{
  label: string
  labelColor?: string
  summary?: string
  blockId?: string
  copyText?: string
  rawData?: unknown
  rawTitle?: string
}>(), {
  labelColor: 'text-muted',
  summary: '',
  rawTitle: 'Raw',
})

const { copy } = useCopyToClipboard()

const collapsed = ref(false)
const expanded = ref(false)
const needsExpand = ref(false)
const showRawModal = ref(false)
const bodyRef = ref<HTMLElement>()

let observer: ResizeObserver | null = null
let rafId: number | null = null

function toggleCollapse() {
  collapsed.value = !collapsed.value
}

function toggleExpand(e: Event) {
  e.stopPropagation()
  expanded.value = !expanded.value
}

function handleCopy(e: Event) {
  e.stopPropagation()
  if (props.copyText) copy(props.copyText)
}

function openRaw(e: Event) {
  e.stopPropagation()
  showRawModal.value = true
}

function checkOverflow() {
  if (rafId !== null) return
  rafId = requestAnimationFrame(() => {
    rafId = null
    if (!bodyRef.value) return
    needsExpand.value = bodyRef.value.scrollHeight > 208
  })
}

onMounted(() => {
  if (bodyRef.value) {
    observer = new ResizeObserver(checkOverflow)
    observer.observe(bodyRef.value)
    nextTick(checkOverflow)
  }
})

onUnmounted(() => {
  observer?.disconnect()
  if (rafId !== null) cancelAnimationFrame(rafId)
})
</script>

<template>
  <div class="content-block" :id="blockId">
    <div class="content-block-header" @click="toggleCollapse">
      <div class="content-block-header-left">
        <span class="collapse-icon">{{ collapsed ? '▸' : '▾' }}</span>
        <span class="content-type-label" :class="'label-' + labelColor">{{ label }}</span>
        <slot name="header-extra" />
        <span v-if="collapsed && summary" class="collapsed-summary">{{ summary }}</span>
      </div>
      <div class="content-block-header-right">
        <button
          v-if="!collapsed && needsExpand"
          class="action-btn"
          :title="expanded ? 'Collapse' : 'Expand'"
          @click="toggleExpand"
        >
          <IconSvg :name="expanded ? 'contract' : 'expand'" :size="10" />
          {{ expanded ? 'Collapse' : 'Expand' }}
        </button>
        <button
          v-if="copyText"
          class="action-btn"
          title="Copy"
          @click="handleCopy"
        >
          <IconSvg name="copy" :size="10" />
          Copy
        </button>
        <button
          v-if="rawData !== undefined"
          class="action-btn"
          title="View raw JSON"
          @click="openRaw"
        >
          <IconSvg name="code" :size="10" />
          Raw
        </button>
      </div>
    </div>
    <div
      v-show="!collapsed"
      ref="bodyRef"
      class="content-block-body"
      :class="{ 'body-collapsed': !expanded }"
    >
      <slot />
    </div>

    <RawJsonModal
      v-if="rawData !== undefined"
      :visible="showRawModal"
      :title="rawTitle"
      :data="rawData"
      @update:visible="showRawModal = $event"
    />
  </div>
</template>

<style scoped>
.content-block {
  border: 1px solid var(--border);
}

.content-block-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--bg-tertiary);
  cursor: pointer;
  user-select: none;
}

.content-block-header:hover {
  background: var(--bg-hover);
}

.content-block-header-left {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-sm);
  min-width: 0;
  overflow: hidden;
}

.content-block-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.collapse-icon {
  font-size: 10px;
  color: var(--text-dim);
  width: 10px;
  flex-shrink: 0;
}

.content-type-label {
  font-size: var(--font-size-xs);
  font-weight: 600;
  letter-spacing: 0.5px;
  flex-shrink: 0;
}

.label-text { color: var(--text-muted); }
.label-cyan { color: var(--cyan); }
.label-success { color: var(--success); }
.label-error { color: var(--error); }
.label-purple { color: var(--purple); }
.label-pink { color: var(--pink); }
.label-warning { color: var(--warning); }
.label-text-muted { color: var(--text-muted); }

.collapsed-summary {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  padding: 2px 6px;
  background: transparent;
}

.action-btn:hover {
  color: var(--text);
  background: var(--bg-hover);
}

.content-block-body {
  padding: var(--spacing-sm);
}

.body-collapsed {
  max-height: 200px;
  overflow-y: auto;
}
</style>
