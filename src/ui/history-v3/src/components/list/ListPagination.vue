<script setup lang="ts">
import { inject, computed } from 'vue'
import type { HistoryStore } from '@/composables/useHistoryStore'

const store = inject<HistoryStore>('historyStore')!

// Compute visible page numbers (max 5, with ellipsis)
const visiblePages = computed(() => {
  const current = store.page.value
  const total = store.totalPages.value
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }

  const pages: (number | '...')[] = []
  pages.push(1)
  if (current > 3) pages.push('...')

  const start = Math.max(2, current - 1)
  const end = Math.min(total - 1, current + 1)
  for (let i = start; i <= end; i++) {
    pages.push(i)
  }

  if (current < total - 2) pages.push('...')
  pages.push(total)

  return pages
})
</script>

<template>
  <div class="list-pagination" v-if="store.totalPages.value > 1">
    <button
      class="page-btn nav-btn"
      :disabled="store.page.value <= 1"
      @click="store.setPage(store.page.value - 1)"
    >
      &laquo;
    </button>

    <template v-for="(p, i) in visiblePages" :key="i">
      <span v-if="p === '...'" class="page-ellipsis">...</span>
      <button
        v-else
        class="page-btn"
        :class="{ active: p === store.page.value }"
        @click="store.setPage(p)"
      >
        {{ p }}
      </button>
    </template>

    <button
      class="page-btn nav-btn"
      :disabled="store.page.value >= store.totalPages.value"
      @click="store.setPage(store.page.value + 1)"
    >
      &raquo;
    </button>
  </div>
</template>

<style scoped>
.list-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: var(--spacing-sm);
  border-top: 1px solid var(--border-light);
  flex-shrink: 0;
}

.page-btn {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  padding: 2px 8px;
  min-width: 24px;
  text-align: center;
}

.page-btn:hover:not(:disabled) {
  background: var(--primary-muted);
  color: var(--primary);
}

.page-btn.active {
  background: var(--primary);
  color: var(--primary-contrast);
  font-weight: 600;
}

.page-btn:disabled {
  color: var(--text-dim);
  cursor: not-allowed;
}

.nav-btn {
  color: var(--primary);
}

.page-ellipsis {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  padding: 0 4px;
}
</style>
