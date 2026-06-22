import { defineStore } from "pinia"
import { shallowRef } from "vue"

import { useHistoryData } from "./history-store/useHistoryData"
import { useHistoryWS } from "./history-store/useHistoryWS"
import { useToast } from "./useToast"

export const useHistoryStore = defineStore("history", () => {
  const { show: showToast } = useToast()
  const data = useHistoryData(showToast)
  const wsConnected = shallowRef(false)

  const realtime = useHistoryWS({
    entries: data.entries,
    prevCursor: data.prevCursor,
    total: data.total,
    stats: data.stats,
    selectedEntry: data.selectedEntry,
    wsConnected,
    pageSize: data.pageSize,
    refresh: data.refresh,
    selectEntry: data.selectEntry,
  })

  return {
    entries: data.entries,
    selectedEntry: data.selectedEntry,
    stats: data.stats,
    filters: data.filters,
    searchQuery: data.searchQuery,
    filterEndpoint: data.filterEndpoint,
    filterSuccess: data.filterSuccess,
    selectedSessionId: data.selectedSessionId,
    nextCursor: data.nextCursor,
    prevCursor: data.prevCursor,
    total: data.total,
    hasMore: data.hasMore,
    loading: data.loading,
    error: data.error,
    wsConnected,
    hasSelection: data.hasSelection,
    selectedIndex: data.selectedIndex,
    fetchEntries: data.fetchEntries,
    fetchStats: data.fetchStats,
    selectEntry: data.selectEntry,
    selectAdjacentEntry: data.selectAdjacentEntry,
    clearSelection: data.clearSelection,
    clearAll: data.clearAll,
    refresh: data.refresh,
    loadNext: data.loadNext,
    loadPrev: data.loadPrev,
    setFilter: data.setFilter,
    clearFilter: data.clearFilter,
    clearFilters: data.clearFilters,
    setSessionFilter: data.setSessionFilter,
    setEndpointFilter: data.setEndpointFilter,
    setSuccessFilter: data.setSuccessFilter,
    setSearch: data.setSearch,
    init: realtime.init,
    destroy: realtime.destroy,
  }
})

/** Store type for consumers that need explicit typing */
export type HistoryStore = ReturnType<typeof useHistoryStore>

export { extractText, getMessageSummary, getPreviewText, getStatusClass } from "./history-store/helpers"
