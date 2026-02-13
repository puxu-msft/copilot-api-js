<script setup lang="ts">
import { NConfigProvider, NLayout, NLayoutHeader, NLayoutContent, darkTheme, NMessageProvider } from 'naive-ui'
import { ref, computed, onMounted, onUnmounted } from 'vue'
import AppHeader from './components/AppHeader.vue'
import StatsBar from './components/StatsBar.vue'
import RequestList from './components/RequestList.vue'
import DetailPanel from './components/DetailPanel.vue'
import ThemeVarsProvider from './components/ThemeVarsProvider.vue'
import { useHistoryStore } from './composables/useHistoryStore'

const store = useHistoryStore()

// Theme detection
const prefersDark = ref(window.matchMedia('(prefers-color-scheme: dark)').matches)

onMounted(() => {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    prefersDark.value = e.matches
  })
})

// Keyboard navigation
const handleKeydown = (e: KeyboardEvent) => {
  const tag = (e.target as HTMLElement)?.tagName
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'

  // "/" to focus search (only when not in input)
  if (e.key === '/' && !isInput) {
    e.preventDefault()
    const searchInput = document.querySelector('.search-input input') as HTMLInputElement
    searchInput?.focus()
    return
  }

  // Escape to clear selection or blur search
  if (e.key === 'Escape') {
    if (isInput) {
      ;(e.target as HTMLElement).blur()
      return
    }
    if (store.selectedEntry.value) {
      store.clearSelection()
      return
    }
  }

  // Arrow keys for entry navigation (only when not in input)
  if (!isInput && (e.key === 'ArrowDown' || e.key === 'j')) {
    e.preventDefault()
    store.selectAdjacentEntry('next')
    return
  }
  if (!isInput && (e.key === 'ArrowUp' || e.key === 'k')) {
    e.preventDefault()
    store.selectAdjacentEntry('prev')
    return
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})

const theme = computed(() => prefersDark.value ? darkTheme : null)
</script>

<template>
  <NConfigProvider :theme="theme">
    <NMessageProvider>
      <ThemeVarsProvider>
        <NLayout class="app-layout">
          <NLayoutHeader class="app-header">
            <AppHeader
              :sessions="store.sessions.value"
              :selected-session-id="store.selectedSessionId.value"
              @session-change="store.setSessionFilter"
              @refresh="store.refresh"
              @clear="store.clearAll"
            />
          </NLayoutHeader>

          <StatsBar :stats="store.stats.value" />

          <NLayoutContent class="app-content">
            <div class="main-container">
              <RequestList
                :entries="store.entries.value"
                :loading="store.loading.value"
                :selected-id="store.selectedEntry.value?.id"
                :page="store.page.value"
                :total-pages="store.totalPages.value"
                :total="store.total.value"
                :search-query="store.searchQuery.value"
                :filter-endpoint="store.filterEndpoint.value"
                :filter-success="store.filterSuccess.value"
                @select="store.selectEntry"
                @page-change="store.setPage"
                @search="store.setSearch"
                @filter-endpoint="store.setEndpointFilter"
                @filter-success="store.setSuccessFilter"
              />

              <DetailPanel
                :entry="store.selectedEntry.value"
                @close="store.clearSelection"
              />
            </div>
          </NLayoutContent>
        </NLayout>
      </ThemeVarsProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style>
html, body {
  margin: 0;
  padding: 0;
  height: 100%;
  overflow: hidden;
}

#app {
  height: 100%;
}

.app-layout {
  height: 100vh;
}

.app-header {
  border-bottom: 1px solid var(--n-border-color);
}

.app-content {
  height: calc(100vh - 110px);
  overflow: hidden;
}

.main-container {
  display: flex;
  height: 100%;
}
</style>
