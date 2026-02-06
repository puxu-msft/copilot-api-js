<script setup lang="ts">
import { NSelect, NButton, NIcon, NPopconfirm, NDropdown } from 'naive-ui'
import { Refresh, Download, TrashBinOutline } from '@vicons/ionicons5'
import type { Session } from '@/types'
import { computed } from 'vue'
import { formatDate } from '@/composables/useFormatters'
import { getExportUrl } from '@/api'

const props = defineProps<{
  sessions: Session[]
  selectedSessionId: string | null
}>()

const emit = defineEmits<{
  sessionChange: [sessionId: string | null]
  refresh: []
  clear: []
}>()

const sessionOptions = computed(() => {
  const options = [
    { label: 'All Sessions', value: '' }
  ]
  for (const session of props.sessions) {
    options.push({
      label: `${formatDate(session.startTime)} (${session.requestCount} reqs)`,
      value: session.id
    })
  }
  return options
})

const handleSessionChange = (value: string) => {
  emit('sessionChange', value || null)
}

const handleExport = (format: 'json' | 'csv') => {
  window.open(getExportUrl(format), '_blank')
}

const exportOptions = [
  { label: 'Export JSON', key: 'json' },
  { label: 'Export CSV', key: 'csv' },
]

const handleExportSelect = (key: string) => {
  handleExport(key as 'json' | 'csv')
}
</script>

<template>
  <div class="header-container">
    <div class="header-left">
      <h1 class="title">Request History <span class="version-badge">V2</span></h1>
    </div>
    <div class="header-right">
      <NSelect
        :value="selectedSessionId || ''"
        :options="sessionOptions"
        style="width: 220px"
        size="small"
        @update:value="handleSessionChange"
      />
      <NButton size="small" @click="$emit('refresh')">
        <template #icon>
          <NIcon><Refresh /></NIcon>
        </template>
        Refresh
      </NButton>
      <NDropdown :options="exportOptions" @select="handleExportSelect">
        <NButton size="small">
          <template #icon>
            <NIcon><Download /></NIcon>
          </template>
          Export
        </NButton>
      </NDropdown>
      <NPopconfirm @positive-click="$emit('clear')">
        <template #trigger>
          <NButton size="small" type="error">
            <template #icon>
              <NIcon><TrashBinOutline /></NIcon>
            </template>
            Clear
          </NButton>
        </template>
        Are you sure you want to clear all history?
      </NPopconfirm>
    </div>
  </div>
</template>

<style scoped>
.header-container {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--n-border-color);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.title {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.version-badge {
  font-size: 11px;
  font-weight: 400;
  color: var(--n-text-color-3);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
