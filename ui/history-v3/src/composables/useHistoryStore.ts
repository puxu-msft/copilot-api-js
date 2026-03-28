import { ref, type ComputedRef, type Ref } from "vue"

import type { EntrySummary, HistoryEntry, HistoryStats, Session } from "../types"

import { extractText, getMessageSummary, getPreviewText, getStatusClass } from "./history-store/helpers"
import { useHistoryData } from "./history-store/useHistoryData"
import { useHistoryWS } from "./history-store/useHistoryWS"
import { useToast } from "./useToast"

export interface HistoryStore {
  entries: Ref<Array<EntrySummary>>
  selectedEntry: Ref<HistoryEntry | null>
  sessions: Ref<Array<Session>>
  stats: Ref<HistoryStats | null>

  searchQuery: Ref<string>
  filterEndpoint: Ref<string | null>
  filterSuccess: Ref<string | null>
  selectedSessionId: Ref<string | null>

  nextCursor: Ref<string | null>
  prevCursor: Ref<string | null>
  total: Ref<number>
  hasMore: Ref<boolean>

  loading: Ref<boolean>
  error: Ref<string | null>
  wsConnected: Ref<boolean>

  detailSearch: Ref<string>
  detailFilterRole: Ref<string>
  detailFilterType: Ref<string>
  aggregateTools: Ref<boolean>
  detailViewMode: Ref<"original" | "rewritten" | "diff" | null>
  showOnlyRewritten: Ref<boolean>

  hasSelection: ComputedRef<boolean>
  selectedIndex: ComputedRef<number>

  fetchEntries: () => Promise<void>
  fetchStats: () => Promise<void>
  fetchSessions: () => Promise<void>
  selectEntry: (id: string) => Promise<void>
  selectAdjacentEntry: (direction: "next" | "prev") => void
  clearSelection: () => void
  clearAll: () => Promise<void>
  refresh: () => Promise<void>
  loadNext: () => void
  loadPrev: () => void
  setSessionFilter: (id: string | null) => void
  setEndpointFilter: (ep: string | null) => void
  setSuccessFilter: (s: string | null) => void
  setSearch: (q: string) => void
  init: () => void
  destroy: () => void
}

export function useHistoryStore(): HistoryStore {
  const { show: showToast } = useToast()
  const data = useHistoryData(showToast)
  const wsConnected = ref(false)

  const detailSearch = ref("")
  const detailFilterRole = ref("")
  const detailFilterType = ref("")
  const aggregateTools = ref(true)
  const detailViewMode = ref<"original" | "rewritten" | "diff" | null>(null)
  const showOnlyRewritten = ref(false)

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
    sessions: data.sessions,
    stats: data.stats,
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
    detailSearch,
    detailFilterRole,
    detailFilterType,
    aggregateTools,
    detailViewMode,
    showOnlyRewritten,
    hasSelection: data.hasSelection,
    selectedIndex: data.selectedIndex,
    fetchEntries: data.fetchEntries,
    fetchStats: data.fetchStats,
    fetchSessions: data.fetchSessions,
    selectEntry: data.selectEntry,
    selectAdjacentEntry: data.selectAdjacentEntry,
    clearSelection: data.clearSelection,
    clearAll: data.clearAll,
    refresh: data.refresh,
    loadNext: data.loadNext,
    loadPrev: data.loadPrev,
    setSessionFilter: data.setSessionFilter,
    setEndpointFilter: data.setEndpointFilter,
    setSuccessFilter: data.setSuccessFilter,
    setSearch: data.setSearch,
    init: realtime.init,
    destroy: realtime.destroy,
  }
}

export { extractText, getMessageSummary, getPreviewText, getStatusClass }
