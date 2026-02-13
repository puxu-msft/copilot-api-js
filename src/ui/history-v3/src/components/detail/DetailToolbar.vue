<script setup lang="ts">
import { inject } from 'vue'
import type { HistoryStore } from '@/composables/useHistoryStore'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseCheckbox from '@/components/ui/BaseCheckbox.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import IconSvg from '@/components/ui/IconSvg.vue'

const store = inject<HistoryStore>('historyStore')!

defineEmits<{
  showRaw: []
}>()

const roleOptions = [
  { value: 'system', label: 'System' },
  { value: 'user', label: 'User' },
  { value: 'assistant', label: 'Assistant' },
  { value: 'tool', label: 'Tool' },
]

const typeOptions = [
  { value: 'text', label: 'Text' },
  { value: 'tool_use', label: 'Tool Use' },
  { value: 'tool_result', label: 'Tool Result' },
  { value: 'thinking', label: 'Thinking' },
  { value: 'image', label: 'Image' },
]
</script>

<template>
  <div class="detail-toolbar">
    <BaseInput
      :model-value="store.detailSearch.value"
      placeholder="Search in messages..."
      icon="search"
      @update:model-value="store.detailSearch.value = $event"
    />
    <div class="toolbar-row">
      <BaseSelect
        :model-value="store.detailFilterRole.value || null"
        :options="roleOptions"
        placeholder="Role"
        @update:model-value="store.detailFilterRole.value = $event ?? ''"
      />
      <BaseSelect
        :model-value="store.detailFilterType.value || null"
        :options="typeOptions"
        placeholder="Type"
        @update:model-value="store.detailFilterType.value = $event ?? ''"
      />
      <BaseCheckbox
        :model-value="store.aggregateTools.value"
        label="Aggregate Tools"
        @update:model-value="store.aggregateTools.value = $event"
      />
      <BaseButton variant="ghost" @click="$emit('showRaw')">
        <IconSvg name="code" :size="13" />
        Raw
      </BaseButton>
    </div>
  </div>
</template>

<style scoped>
.detail-toolbar {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm);
  border-bottom: 1px solid var(--border-light);
  flex-shrink: 0;
  background: var(--bg-secondary);
}

.toolbar-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-wrap: wrap;
}
</style>
