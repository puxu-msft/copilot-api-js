<script setup lang="ts">
import { ref } from "vue"
import { watchDebounced } from "@vueuse/core"

import BaseInput from "@/components/ui/BaseInput.vue"
import BaseSelect from "@/components/ui/BaseSelect.vue"
import { useHistoryStore } from "@/composables/useHistoryStore"

import ListPagination from "./ListPagination.vue"
import RequestItem from "./RequestItem.vue"

const store = useHistoryStore()

const localSearch = ref("")

const searchInputRef = ref<InstanceType<typeof BaseInput>>()

watchDebounced(localSearch, (val) => store.setSearch(val), { debounce: 300 })

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
        v-if="localSearch && store.total > 0"
        class="search-count"
      >
        {{ store.total }} hit{{ store.total !== 1 ? "s" : "" }}
      </span>
      <div class="list-filters">
        <BaseSelect
          :model-value="store.filterEndpoint"
          :options="endpointOptions"
          placeholder="Endpoint"
          @update:model-value="store.setEndpointFilter($event)"
        />
        <BaseSelect
          :model-value="store.filterSuccess"
          :options="statusOptions"
          placeholder="Status"
          @update:model-value="store.setSuccessFilter($event)"
        />
      </div>
    </div>

    <div class="list-body">
      <div
        v-if="store.loading && store.entries.length === 0"
        class="list-empty"
      >
        Loading...
      </div>
      <div
        v-else-if="store.entries.length === 0"
        class="list-empty"
      >
        No requests found
        <p class="empty-subtitle">Try adjusting your filters</p>
      </div>
      <template v-else>
        <RequestItem
          v-for="entry in store.entries"
          :key="entry.id"
          :entry="entry"
          :selected="store.selectedEntry?.id === entry.id"
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
