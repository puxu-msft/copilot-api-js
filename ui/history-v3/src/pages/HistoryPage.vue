<script setup lang="ts">
import { ref } from "vue"

import DetailPanel from "@/components/detail/DetailPanel.vue"
import AppHeader from "@/components/layout/AppHeader.vue"
import SplitPane from "@/components/layout/SplitPane.vue"
import StatsBar from "@/components/layout/StatsBar.vue"
import RequestList from "@/components/list/RequestList.vue"
import ErrorBoundary from "@/components/ui/ErrorBoundary.vue"
import { useFormatters } from "@/composables/useFormatters"
import { useInjectedHistoryStore } from "@/composables/useInjectedHistoryStore"
import { useKeyboard } from "@/composables/useKeyboard"

const store = useInjectedHistoryStore()
const { formatDate } = useFormatters()

const requestListRef = ref<InstanceType<typeof RequestList>>()

useKeyboard({
  onNavigate: (dir) => store.selectAdjacentEntry(dir),
  onSearch: () => requestListRef.value?.focusSearch(),
  onEscape: () => store.clearSelection(),
})

// Expose formatDate for session selector in the toolbar
void formatDate
</script>

<template>
  <div class="history-page">
    <AppHeader />
    <StatsBar />
    <SplitPane>
      <template #left>
        <ErrorBoundary label="Request list">
          <RequestList ref="requestListRef" />
        </ErrorBoundary>
      </template>
      <template #right>
        <ErrorBoundary label="Detail panel">
          <DetailPanel />
        </ErrorBoundary>
      </template>
    </SplitPane>
  </div>
</template>

<style scoped>
.history-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}
</style>
