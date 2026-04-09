import { computed, ref, type ComputedRef, type Ref } from "vue"

import type { EndpointType, EntrySummary, HistoryEntry, HistoryStats, Session } from "@/types"

import { api } from "@/api/http"

export interface HistoryDataState {
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
  hasSelection: ComputedRef<boolean>
  selectedIndex: ComputedRef<number>
  pageSize: number
  fetchEntries: (cursor?: string, direction?: "older" | "newer") => Promise<void>
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
}

export function useHistoryData(showToast: (message: string, type: "success" | "error") => void): HistoryDataState {
  const entries = ref<Array<EntrySummary>>([])
  const selectedEntry = ref<HistoryEntry | null>(null)
  const sessions = ref<Array<Session>>([])
  const stats = ref<HistoryStats | null>(null)

  const searchQuery = ref("")
  const filterEndpoint = ref<string | null>(null)
  const filterSuccess = ref<string | null>(null)
  const selectedSessionId = ref<string | null>(null)

  const nextCursor = ref<string | null>(null)
  const prevCursor = ref<string | null>(null)
  const total = ref(0)
  const hasMore = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const pageSize = 20

  const hasSelection = computed(() => selectedEntry.value !== null)
  const selectedIndex = computed(() => {
    if (!selectedEntry.value) return -1
    return entries.value.findIndex((e) => e.id === selectedEntry.value?.id)
  })

  async function fetchEntries(cursor?: string, direction?: "older" | "newer"): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const result = await api.fetchEntries({
        cursor,
        direction,
        limit: pageSize,
        endpoint: filterEndpoint.value as EndpointType | undefined,
        success: filterSuccess.value === null ? undefined : filterSuccess.value === "true",
        search: searchQuery.value || undefined,
        sessionId: selectedSessionId.value || undefined,
      })
      entries.value = result.entries
      nextCursor.value = result.nextCursor
      prevCursor.value = result.prevCursor
      total.value = result.total
      hasMore.value = result.nextCursor !== null

      if (selectedEntry.value === null && entries.value.length > 0) {
        await selectEntry(entries.value[0].id)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load entries"
      error.value = msg
      showToast(msg, "error")
    } finally {
      loading.value = false
    }
  }

  async function fetchStats(): Promise<void> {
    try {
      stats.value = await api.fetchStats()
    } catch {
      // Stats are non-critical, don't show error
    }
  }

  async function fetchSessions(): Promise<void> {
    try {
      const result = await api.fetchSessions()
      sessions.value = result.sessions
    } catch {
      // Sessions are non-critical
    }
  }

  async function selectEntry(id: string): Promise<void> {
    try {
      selectedEntry.value = await api.fetchEntry(id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load entry"
      showToast(msg, "error")
    }
  }

  function selectAdjacentEntry(direction: "next" | "prev"): void {
    const idx = selectedIndex.value
    if (entries.value.length === 0) return

    let newIdx: number
    if (idx === -1) {
      newIdx = 0
    } else if (direction === "next") {
      newIdx = Math.min(idx + 1, entries.value.length - 1)
    } else {
      newIdx = Math.max(idx - 1, 0)
    }

    const entry = entries.value[newIdx]
    if (entry) {
      void selectEntry(entry.id)
    }
  }

  function clearSelection(): void {
    selectedEntry.value = null
  }

  async function clearAll(): Promise<void> {
    try {
      await api.deleteEntries()
      entries.value = []
      selectedEntry.value = null
      stats.value = null
      total.value = 0
      nextCursor.value = null
      prevCursor.value = null
      hasMore.value = false
      showToast("History cleared", "success")
      await fetchStats()
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to clear history"
      showToast(msg, "error")
    }
  }

  async function refresh(): Promise<void> {
    const currentId = selectedEntry.value?.id
    await Promise.all([fetchEntries(), fetchStats(), fetchSessions()])
    if (currentId) {
      await selectEntry(currentId)
    }
  }

  function loadNext(): void {
    if (!nextCursor.value) return
    void fetchEntries(nextCursor.value, "older")
  }

  function loadPrev(): void {
    if (!prevCursor.value) return
    void fetchEntries(prevCursor.value, "newer")
  }

  function resetCursors(): void {
    nextCursor.value = null
    prevCursor.value = null
  }

  function setSessionFilter(id: string | null): void {
    selectedSessionId.value = id
    resetCursors()
    void fetchEntries()
  }

  function setEndpointFilter(ep: string | null): void {
    filterEndpoint.value = ep
    resetCursors()
    void fetchEntries()
  }

  function setSuccessFilter(s: string | null): void {
    filterSuccess.value = s
    resetCursors()
    void fetchEntries()
  }

  function setSearch(q: string): void {
    searchQuery.value = q
    resetCursors()
    void fetchEntries()
  }

  return {
    entries,
    selectedEntry,
    sessions,
    stats,
    searchQuery,
    filterEndpoint,
    filterSuccess,
    selectedSessionId,
    nextCursor,
    prevCursor,
    total,
    hasMore,
    loading,
    error,
    hasSelection,
    selectedIndex,
    pageSize,
    fetchEntries,
    fetchStats,
    fetchSessions,
    selectEntry,
    selectAdjacentEntry,
    clearSelection,
    clearAll,
    refresh,
    loadNext,
    loadPrev,
    setSessionFilter,
    setEndpointFilter,
    setSuccessFilter,
    setSearch,
  }
}
