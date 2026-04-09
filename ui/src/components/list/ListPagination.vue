<script setup lang="ts">
import { useInjectedHistoryStore } from "@/composables/useInjectedHistoryStore"

const store = useInjectedHistoryStore()
</script>

<template>
  <div
    class="list-pagination"
    v-if="store.total.value > 0"
  >
    <button
      class="page-btn nav-btn"
      :disabled="!store.prevCursor.value"
      @click="store.loadPrev()"
    >
      Previous
    </button>

    <span class="page-info"> {{ store.entries.value.length }} of {{ store.total.value }} </span>

    <button
      class="page-btn nav-btn"
      :disabled="!store.nextCursor.value"
      @click="store.loadNext()"
    >
      Next
    </button>
  </div>
</template>

<style scoped>
.list-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-md);
  padding: var(--spacing-sm);
  border-top: 1px solid var(--border-light);
  flex-shrink: 0;
}

.page-btn {
  font-size: var(--font-size-xs);
  color: var(--primary);
  padding: var(--spacing-xs) var(--spacing-md);
  background: transparent;
  cursor: pointer;
}

.page-btn:hover:not(:disabled) {
  background: var(--primary-muted);
}

.page-btn:disabled {
  color: var(--text-dim);
  cursor: not-allowed;
}

.page-info {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  font-family: var(--font-mono);
}
</style>
