<script setup lang="ts">
import { inject, computed, ref, onMounted, onUnmounted } from 'vue'
import type { HistoryStore } from '@/composables/useHistoryStore'
import { useFormatters } from '@/composables/useFormatters'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import IconSvg from '@/components/ui/IconSvg.vue'
import StatusDot from '@/components/ui/StatusDot.vue'

const store = inject<HistoryStore>('historyStore')!
const { formatDate } = useFormatters()

const refreshing = ref(false)

const sessionOptions = computed(() =>
  store.sessions.value.map(s => ({
    value: s.id,
    label: `${formatDate(s.startTime)} (${s.requestCount} reqs)`,
  }))
)

// Export dropdown
const exportOpen = ref(false)
const exportRef = ref<HTMLElement>()

function handleExport(format: 'json' | 'csv') {
  location.href = `/history/api/export?format=${format}`
  exportOpen.value = false
}

function handleClickOutside(e: MouseEvent) {
  if (exportRef.value && !exportRef.value.contains(e.target as Node)) {
    exportOpen.value = false
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && exportOpen.value) {
    exportOpen.value = false
    e.stopPropagation()
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
  document.addEventListener('keydown', handleKeydown)
})
onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  document.removeEventListener('keydown', handleKeydown)
})

async function handleClear() {
  if (!confirm('Clear all history? This cannot be undone.')) return
  await store.clearAll()
}

async function handleRefresh() {
  refreshing.value = true
  try {
    await store.refresh()
  } finally {
    refreshing.value = false
  }
}
</script>

<template>
  <header class="app-header">
    <div class="header-left">
      <h1 class="header-title">History <span class="version-tag">V3</span></h1>
      <BaseSelect
        :model-value="store.selectedSessionId.value"
        :options="sessionOptions"
        placeholder="All Sessions"
        @update:model-value="store.setSessionFilter($event)"
      />
    </div>
    <div class="header-right">
      <StatusDot
        :status="store.wsConnected.value ? 'success' : 'error'"
        :size="6"
      />
      <span class="ws-label">{{ store.wsConnected.value ? 'Live' : 'Offline' }}</span>

      <BaseButton variant="ghost" :disabled="refreshing" @click="handleRefresh">
        <IconSvg name="refresh" :size="13" :class="{ spinning: refreshing }" />
        {{ refreshing ? 'Refreshing...' : 'Refresh' }}
      </BaseButton>

      <div ref="exportRef" class="export-dropdown">
        <BaseButton variant="ghost" @click.stop="exportOpen = !exportOpen">
          <IconSvg name="download" :size="13" />
          Export
        </BaseButton>
        <div v-show="exportOpen" class="export-menu">
          <button class="export-item" @click="handleExport('json')">Export JSON</button>
          <button class="export-item" @click="handleExport('csv')">Export CSV</button>
        </div>
      </div>

      <BaseButton variant="danger" @click="handleClear">
        <IconSvg name="trash" :size="13" />
        Clear
      </BaseButton>
    </div>
  </header>
</template>

<style scoped>
.app-header {
  height: var(--header-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--spacing-lg);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
}

.header-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text);
}

.version-tag {
  font-size: var(--font-size-xs);
  font-weight: 500;
  color: var(--text-dim);
  vertical-align: super;
}

.header-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.ws-label {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  margin-right: var(--spacing-sm);
}

.export-dropdown {
  position: relative;
}

.export-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  min-width: 120px;
  z-index: 100;
  box-shadow: var(--shadow-md);
}

.export-item {
  display: block;
  width: 100%;
  padding: 8px 12px;
  text-align: left;
  font-size: var(--font-size-sm);
  color: var(--text);
  background: transparent;
}

.export-item:hover {
  background: var(--bg-hover);
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.spinning {
  animation: spin 1s linear infinite;
}

@media (max-width: 768px) {
  .app-header {
    flex-wrap: wrap;
    height: auto;
    padding: var(--spacing-sm) var(--spacing-md);
    gap: var(--spacing-sm);
  }
}
</style>
