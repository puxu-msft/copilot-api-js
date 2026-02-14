import type { Ref } from "vue"

import { ref, onMounted, onUnmounted } from "vue"

import type {
  HistoryEntry,
  HistoryResult,
  HistoryStats,
  QueryOptions,
  Session,
  SessionResult,
  WSMessage,
} from "@/types"

import * as api from "@/api"

// Store for history data
export function useHistoryStore() {
  const entries: Ref<Array<HistoryEntry>> = ref([])
  const sessions: Ref<Array<Session>> = ref([])
  const stats: Ref<HistoryStats | null> = ref(null)
  const selectedEntry: Ref<HistoryEntry | null> = ref(null)
  const selectedSessionId: Ref<string | null> = ref(null)

  const loading = ref(false)
  const error: Ref<string | null> = ref(null)

  const page = ref(1)
  const totalPages = ref(1)
  const total = ref(0)
  const limit = ref(20)

  const searchQuery = ref("")
  const filterEndpoint: Ref<string | null> = ref(null)
  const filterSuccess: Ref<boolean | null> = ref(null)

  // WebSocket
  let ws: WebSocket | null = null
  let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
  let wsReconnectDelay = 1000
  let wsUnmounted = false
  const WS_MAX_RECONNECT_DELAY = 30000

  const connectWebSocket = () => {
    if (wsUnmounted) return

    ws = api.createWebSocket()
    if (!ws) return

    ws.addEventListener("open", () => {
      // Reset backoff on successful connection
      wsReconnectDelay = 1000
    })

    ws.addEventListener("message", (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data)
        handleWSMessage(message)
      } catch (e) {
        console.error("Failed to parse WebSocket message:", e)
      }
    })

    ws.addEventListener("close", () => {
      if (wsUnmounted) return
      // Reconnect with exponential backoff
      wsReconnectTimer = setTimeout(connectWebSocket, wsReconnectDelay)
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_RECONNECT_DELAY)
    })

    ws.addEventListener("error", (e) => {
      console.error("WebSocket error:", e)
    })
  }

  const handleWSMessage = (message: WSMessage) => {
    switch (message.type) {
      case "entry_added": {
        // Add new entry to the beginning if on first page
        if (page.value === 1) {
          const newEntry = message.data as HistoryEntry
          // Check if matches current filters
          if (matchesFilters(newEntry)) {
            entries.value = [newEntry, ...entries.value.slice(0, limit.value - 1)]
            total.value++
          }
        }
        break
      }
      case "entry_updated": {
        const updatedEntry = message.data as HistoryEntry
        const index = entries.value.findIndex((e) => e.id === updatedEntry.id)
        if (index !== -1) {
          entries.value[index] = updatedEntry
        }
        if (selectedEntry.value?.id === updatedEntry.id) {
          selectedEntry.value = updatedEntry
        }
        break
      }
      case "stats_updated": {
        stats.value = message.data as HistoryStats
        break
      }
    }
  }

  const matchesFilters = (entry: HistoryEntry): boolean => {
    if (selectedSessionId.value && entry.sessionId !== selectedSessionId.value) return false
    if (filterEndpoint.value && entry.endpoint !== filterEndpoint.value) return false
    if (filterSuccess.value !== null && entry.response?.success !== filterSuccess.value) return false
    return true
  }

  const fetchEntries = async () => {
    loading.value = true
    error.value = null
    try {
      const options: QueryOptions = {
        page: page.value,
        limit: limit.value,
      }
      if (selectedSessionId.value) options.sessionId = selectedSessionId.value
      if (filterEndpoint.value) options.endpoint = filterEndpoint.value
      if (filterSuccess.value !== null) options.success = filterSuccess.value
      if (searchQuery.value) options.search = searchQuery.value

      const result: HistoryResult = await api.fetchEntries(options)
      entries.value = result.entries
      total.value = result.total
      totalPages.value = result.totalPages
    } catch (e) {
      error.value = e instanceof Error ? e.message : "Failed to fetch entries"
    } finally {
      loading.value = false
    }
  }

  const fetchSessions = async () => {
    try {
      const result: SessionResult = await api.fetchSessions()
      sessions.value = result.sessions
    } catch (e) {
      console.error("Failed to fetch sessions:", e)
    }
  }

  const fetchStats = async () => {
    try {
      stats.value = await api.fetchStats()
    } catch (e) {
      console.error("Failed to fetch stats:", e)
    }
  }

  const selectEntry = async (id: string) => {
    try {
      selectedEntry.value = await api.fetchEntry(id)
    } catch (e) {
      console.error("Failed to fetch entry:", e)
    }
  }

  const clearSelection = () => {
    selectedEntry.value = null
  }

  const selectAdjacentEntry = async (direction: "next" | "prev") => {
    if (entries.value.length === 0) return
    const currentId = selectedEntry.value?.id
    if (!currentId) {
      // No selection: select first entry
      await selectEntry(entries.value[0].id)
      return
    }
    const currentIndex = entries.value.findIndex((e) => e.id === currentId)
    const nextIndex =
      direction === "next" ?
        currentIndex < entries.value.length - 1 ?
          currentIndex + 1
        : 0
      : currentIndex > 0 ? currentIndex - 1
      : entries.value.length - 1
    await selectEntry(entries.value[nextIndex].id)
  }

  const clearAll = async () => {
    try {
      await api.deleteEntries()
      entries.value = []
      selectedEntry.value = null
      total.value = 0
      totalPages.value = 1
      await fetchStats()
      await fetchSessions()
    } catch (e) {
      error.value = e instanceof Error ? e.message : "Failed to clear history"
    }
  }

  const refresh = () => {
    void fetchEntries()
    void fetchStats()
    void fetchSessions()
  }

  const setPage = (p: number) => {
    page.value = p
    void fetchEntries()
  }

  const setSessionFilter = (sessionId: string | null) => {
    selectedSessionId.value = sessionId
    page.value = 1
    void fetchEntries()
  }

  const setEndpointFilter = (endpoint: string | null) => {
    filterEndpoint.value = endpoint
    page.value = 1
    void fetchEntries()
  }

  const setSuccessFilter = (success: boolean | null) => {
    filterSuccess.value = success
    page.value = 1
    void fetchEntries()
  }

  const setSearch = (query: string) => {
    searchQuery.value = query
    page.value = 1
    void fetchEntries()
  }

  onMounted(async () => {
    await fetchEntries()
    // Auto-select the first (newest) entry if nothing is selected
    if (!selectedEntry.value && entries.value.length > 0) {
      void selectEntry(entries.value[0].id)
    }
    void fetchStats()
    void fetchSessions()
    connectWebSocket()
  })

  onUnmounted(() => {
    wsUnmounted = true
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer)
    }
    if (ws) {
      ws.close()
    }
  })

  return {
    // State
    entries,
    sessions,
    stats,
    selectedEntry,
    selectedSessionId,
    loading,
    error,
    page,
    totalPages,
    total,
    limit,
    searchQuery,
    filterEndpoint,
    filterSuccess,
    // Actions
    fetchEntries,
    fetchSessions,
    fetchStats,
    selectEntry,
    selectAdjacentEntry,
    clearSelection,
    clearAll,
    refresh,
    setPage,
    setSessionFilter,
    setEndpointFilter,
    setSuccessFilter,
    setSearch,
  }
}
