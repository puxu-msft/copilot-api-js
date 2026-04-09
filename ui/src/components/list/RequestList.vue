<script setup lang="ts">
import { ref, watch } from "vue"

import BaseInput from "@/components/ui/BaseInput.vue"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import { useInjectedHistoryStore } from "@/composables/useInjectedHistoryStore"

import ListPagination from "./ListPagination.vue"
import RequestItem from "./RequestItem.vue"

const store = useInjectedHistoryStore()

const localSearch = ref("")
let searchTimer: ReturnType<typeof setTimeout> | null = null

const searchInputRef = ref<InstanceType<typeof BaseInput>>()

watch(localSearch, (val) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    store.setSearch(val)
  }, 300)
})

const endpointOptions = [
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "openai-chat-completions", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
]

const statusOptions = [
  { value: "true", label: "Success" },
  { value: "false", label: "Failed" },
]

function focusSearch() {
  searchInputRef.value?.focus()
}

defineExpose({ focusSearch })
</script>

<template>
  <div class="request-list">
    <div class="list-controls">
      <BaseInput
        ref="searchInputRef"
        v-model="localSearch"
        placeholder="Search..."
        icon="search"
      />
      <span
        v-if="localSearch && store.total.value > 0"
        class="search-count"
      >
        {{ store.total.value }} hit{{ store.total.value !== 1 ? "s" : "" }}
      </span>
      <div class="list-filters">
        <BaseSelect
          :model-value="store.filterEndpoint.value"
          :options="endpointOptions"
          placeholder="Endpoint"
          @update:model-value="store.setEndpointFilter($event)"
        />
        <BaseSelect
          :model-value="store.filterSuccess.value"
          :options="statusOptions"
          placeholder="Status"
          @update:model-value="store.setSuccessFilter($event)"
        />
      </div>
    </div>

    <div class="list-body">
      <div
        v-if="store.loading.value && store.entries.value.length === 0"
        class="list-empty"
      >
        Loading...
      </div>
      <div
        v-else-if="store.entries.value.length === 0"
        class="list-empty"
      >
        No requests found
        <p class="empty-subtitle">Try adjusting your filters</p>
      </div>
      <template v-else>
        <RequestItem
          v-for="entry in store.entries.value"
          :key="entry.id"
          :entry="entry"
          :selected="store.selectedEntry.value?.id === entry.id"
          @select="store.selectEntry($event)"
        />
      </template>
    </div>

    <ListPagination />
  </div>
</template>

<style scoped>
.request-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-secondary);
}

.list-controls {
  padding: var(--spacing-sm);
  border-bottom: 1px solid var(--border-light);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  flex-shrink: 0;
}

.list-filters {
  display: flex;
  gap: var(--spacing-xs);
}

.list-body {
  flex: 1;
  overflow-y: auto;
}

.list-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-dim);
  font-size: var(--font-size-sm);
}

.empty-subtitle {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  opacity: 0.6;
  margin-top: var(--spacing-xs);
}

.search-count {
  font-size: var(--font-size-xs);
  color: var(--text-dim);
  padding-left: var(--spacing-xs);
}
</style>
