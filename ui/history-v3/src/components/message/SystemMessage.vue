<script setup lang="ts">
import { ref, computed } from 'vue'
import type { SystemBlock } from '@/types'
import { useFormatters } from '@/composables/useFormatters'
import { useCopyToClipboard } from '@/composables/useCopyToClipboard'
import { useRawModal } from '@/composables/useRawModal'
import BaseBadge from '@/components/ui/BaseBadge.vue'
import IconSvg from '@/components/ui/IconSvg.vue'
import LineNumberPre from '@/components/ui/LineNumberPre.vue'
import DiffView from './DiffView.vue'

const props = defineProps<{
  system: string | SystemBlock[]
  rewrittenSystem?: string | SystemBlock[] | null
  searchQuery?: string
  /** Global view mode from toolbar — null means per-message control */
  globalViewMode?: 'original' | 'rewritten' | 'diff' | null
}>()

const { highlightSearch, escapeHtml } = useFormatters()
const { copy } = useCopyToClipboard()
const { openRawModal } = useRawModal()

const collapsed = ref(false)
const expanded = ref(false)

// Rewrite view mode: local override or global
const localViewMode = ref<'original' | 'rewritten' | 'diff' | null>(null)

/** Effective view mode: local override takes priority, then global, then default */
const viewMode = computed(() => {
  if (localViewMode.value) return localViewMode.value
  if (props.globalViewMode && hasRewrite.value) return props.globalViewMode
  return 'original'
})

const hasLocalOverride = computed(() => localViewMode.value !== null)

function setLocalViewMode(mode: 'original' | 'rewritten' | 'diff') {
  localViewMode.value = mode
}

function resetLocalViewMode() {
  localViewMode.value = null
}

function systemToText(system: string | SystemBlock[]): string {
  if (typeof system === 'string') return system
  if (Array.isArray(system)) return system.map(b => b.text).join('\n')
  return ''
}

const originalText = computed(() => systemToText(props.system))
const rewrittenText = computed(() => props.rewrittenSystem ? systemToText(props.rewrittenSystem) : '')
const hasRewrite = computed(() => !!props.rewrittenSystem)

const displayText = computed(() => {
  if (viewMode.value === 'rewritten' && hasRewrite.value) return rewrittenText.value
  return originalText.value
})

const displayHtml = computed(() => {
  if (props.searchQuery) return highlightSearch(displayText.value, props.searchQuery)
  return escapeHtml(displayText.value)
})

const summary = computed(() => {
  const t = originalText.value
  return t.length > 80 ? t.slice(0, 80) + '...' : t
})

const systemBlocks = computed<SystemBlock[]>(() => {
  if (typeof props.system === 'string') return [{ type: 'text', text: props.system }]
  return props.system
})

const hasCacheControl = computed(() => {
  if (typeof props.system === 'string') return false
  return props.system.some(b => b.cache_control)
})

const rawData = computed(() => {
  return { system: props.system }
})

const rewrittenRawData = computed(() => {
  if (!props.rewrittenSystem) return null
  return { system: props.rewrittenSystem }
})
</script>

<template>
  <div class="system-message" :class="{ collapsed }">
    <div class="system-header" @click="collapsed = !collapsed">
      <div class="system-header-left">
        <span class="collapse-icon">{{ collapsed ? '▸' : '▾' }}</span>
        <BaseBadge color="purple">system</BaseBadge>
        <BaseBadge v-if="hasCacheControl" color="warning">cached</BaseBadge>
        <BaseBadge v-if="hasRewrite" color="warning">rewritten</BaseBadge>
        <span v-if="collapsed" class="collapsed-summary" :title="summary">{{ summary }}</span>
      </div>

      <div class="system-header-right">
        <!-- Rewrite view toggle -->
        <div v-if="hasRewrite && !collapsed" class="view-toggle" @click.stop>
          <button :class="{ active: viewMode === 'original' }" @click="setLocalViewMode('original')">Original</button>
          <button :class="{ active: viewMode === 'rewritten' }" @click="setLocalViewMode('rewritten')">Rewritten</button>
          <button :class="{ active: viewMode === 'diff' }" @click="setLocalViewMode('diff')">Diff</button>
          <button
            v-if="hasLocalOverride"
            class="reset-btn"
            title="Reset to global view mode"
            @click="resetLocalViewMode()"
          >×</button>
        </div>

        <button v-if="!collapsed" class="action-btn" @click.stop="expanded = !expanded" v-show="!expanded">
          <IconSvg name="expand" :size="10" />
          Expand
        </button>
        <button v-if="!collapsed && expanded" class="action-btn" @click.stop="expanded = false">
          <IconSvg name="contract" :size="10" />
          Collapse
        </button>

        <button class="action-btn" title="Copy" @click.stop="copy(displayText)">
          <IconSvg name="copy" :size="10" />
          Copy
        </button>
        <button class="action-btn" title="View raw JSON" @click.stop="openRawModal(rawData, 'Raw — system', rewrittenRawData)">
          <IconSvg name="code" :size="10" />
          Raw
        </button>
      </div>
    </div>

    <div v-show="!collapsed" class="system-body" :class="{ 'body-expanded': expanded }">
      <DiffView
        v-if="viewMode === 'diff' && hasRewrite"
        :old-text="originalText"
        :new-text="rewrittenText"
      />
      <template v-else-if="viewMode === 'original' && typeof system !== 'string'">
        <div v-for="(block, i) in systemBlocks" :key="i" class="system-block-item">
          <div v-if="block.cache_control" class="cache-label">[cache: {{ block.cache_control.type }}]</div>
          <LineNumberPre :html="searchQuery ? highlightSearch(block.text, searchQuery) : escapeHtml(block.text)" />
        </div>
      </template>
      <LineNumberPre v-else :html="displayHtml" />
    </div>
  </div>
</template>

<style scoped>
.system-message {
  border: 1px solid rgba(163, 113, 247, 0.3);
  overflow: hidden;
  margin-bottom: var(--spacing-sm);
}

.system-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--purple-muted);
  cursor: pointer;
  user-select: none;
}

.system-header:hover {
  background: rgba(163, 113, 247, 0.2);
}

.system-header-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  min-width: 0;
  overflow: hidden;
}

.collapse-icon {
  font-size: 10px;
  color: var(--text-dim);
  width: 10px;
  flex-shrink: 0;
}

.collapsed-summary {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.system-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.view-toggle {
  display: flex;
  gap: 1px;
  background: var(--bg);
  overflow: hidden;
}

.view-toggle button {
  font-size: var(--font-size-xs);
  padding: 2px 8px;
  color: var(--text-muted);
  background: var(--bg-secondary);
}

.view-toggle button:hover {
  color: var(--text);
}

.view-toggle button.active {
  color: var(--primary);
  background: var(--primary-muted);
}

.reset-btn {
  font-size: var(--font-size-sm);
  padding: 2px 6px;
  color: var(--text-dim);
  background: var(--bg-secondary);
  line-height: 1;
}

.reset-btn:hover {
  color: var(--error);
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

.system-body {
  padding: var(--spacing-sm);
  max-height: 400px;
  overflow-y: auto;
}

.system-body.body-expanded {
  max-height: none;
}

.system-block-item {
  margin-bottom: var(--spacing-sm);
}

.system-block-item:last-child {
  margin-bottom: 0;
}

.cache-label {
  font-size: var(--font-size-xs);
  color: var(--warning);
  font-style: italic;
  margin-bottom: 2px;
}
</style>
