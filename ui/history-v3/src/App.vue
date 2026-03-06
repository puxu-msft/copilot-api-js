<script setup lang="ts">
import { provide, onMounted, onUnmounted, ref } from 'vue'
import { useHistoryStore } from '@/composables/useHistoryStore'
import { useKeyboard } from '@/composables/useKeyboard'
import AppHeader from '@/components/layout/AppHeader.vue'
import StatsBar from '@/components/layout/StatsBar.vue'
import SplitPane from '@/components/layout/SplitPane.vue'
import RequestList from '@/components/list/RequestList.vue'
import DetailPanel from '@/components/detail/DetailPanel.vue'
import BaseToast from '@/components/ui/BaseToast.vue'

const store = useHistoryStore()
provide('historyStore', store)

const requestListRef = ref<InstanceType<typeof RequestList>>()

useKeyboard({
  onNavigate: (dir) => store.selectAdjacentEntry(dir),
  onSearch: () => requestListRef.value?.focusSearch(),
  onEscape: () => store.clearSelection(),
})

onMounted(() => store.init())
onUnmounted(() => store.destroy())
</script>

<template>
  <div class="app">
    <AppHeader />
    <StatsBar />
    <SplitPane>
      <template #left>
        <RequestList ref="requestListRef" />
      </template>
      <template #right>
        <DetailPanel />
      </template>
    </SplitPane>
    <BaseToast />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}
</style>
