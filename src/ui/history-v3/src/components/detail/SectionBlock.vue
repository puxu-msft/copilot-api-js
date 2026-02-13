<script setup lang="ts">
import { ref } from 'vue'
import IconSvg from '@/components/ui/IconSvg.vue'
import RawJsonModal from '@/components/ui/RawJsonModal.vue'

const props = withDefaults(defineProps<{
  title: string
  defaultCollapsed?: boolean
  badge?: string
  rawData?: unknown
  rawTitle?: string
}>(), {
  rawTitle: 'Raw',
})

const collapsed = ref(props.defaultCollapsed ?? false)
const showRawModal = ref(false)

function toggle() {
  collapsed.value = !collapsed.value
}

function openRaw(e: Event) {
  e.stopPropagation()
  showRawModal.value = true
}
</script>

<template>
  <div class="section-block" :class="{ collapsed }">
    <div class="section-header" @click="toggle">
      <IconSvg
        :name="collapsed ? 'chevron-right' : 'chevron-down'"
        :size="12"
        class="section-chevron"
      />
      <span class="section-title">{{ title }}</span>
      <span v-if="badge" class="section-badge">{{ badge }}</span>
      <button
        v-if="rawData !== undefined"
        class="section-raw-btn"
        title="View raw JSON"
        @click="openRaw"
      >
        <IconSvg name="code" :size="10" />
        Raw
      </button>
    </div>
    <div v-show="!collapsed" class="section-body">
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
.section-block {
  border: 1px solid var(--border-light);
  margin-bottom: var(--spacing-sm);
  overflow: hidden;
}

.section-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--bg-tertiary);
  cursor: pointer;
  user-select: none;
}

.section-header:hover {
  background: var(--bg-hover);
}

.section-chevron {
  color: var(--text-dim);
  flex-shrink: 0;
}

.section-title {
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
}

.section-badge {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.section-raw-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  padding: 2px 6px;
  background: transparent;
  margin-left: auto;
}

.section-raw-btn:hover {
  color: var(--text);
  background: var(--bg-hover);
}

.section-body {
  padding: var(--spacing-sm);
}
</style>
