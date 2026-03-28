import { ref, onMounted, onUnmounted, type Ref } from "vue"

import type { EntrySummary } from "@/types"

import { api } from "@/api/http"
import { WSClient } from "@/api/ws"

export interface UseLogsReturn {
  entries: Ref<Array<EntrySummary>>
  loading: Ref<boolean>
  wsConnected: Ref<boolean>
}

const MAX_ENTRIES = 200

/** Composable for the compact Logs page: fetches initial data and subscribes to WS updates */
export function useLogs(): UseLogsReturn {
  const entries = ref<Array<EntrySummary>>([])
  const loading = ref(true)
  const wsConnected = ref(false)
  let wsClient: WSClient | null = null

  function handleEntryAdded(summary: EntrySummary): void {
    // Insert at the top, trim from the bottom
    entries.value = [summary, ...entries.value].slice(0, MAX_ENTRIES)
  }

  function handleEntryUpdated(summary: EntrySummary): void {
    entries.value = entries.value.map((e) => (e.id === summary.id ? summary : e))
  }

  async function loadInitial(): Promise<void> {
    loading.value = true
    try {
      const result = await api.fetchEntries({ limit: 100 })
      entries.value = result.entries
    } catch {
      // Non-critical — WS will provide real-time updates
    } finally {
      loading.value = false
    }
  }

  onMounted(() => {
    void loadInitial()

    wsClient = new WSClient({
      topics: ["history"],
      onEntryAdded: handleEntryAdded,
      onEntryUpdated: handleEntryUpdated,
      onHistoryCleared: () => {
        entries.value = []
      },
      onStatusChange: (connected) => {
        wsConnected.value = connected
      },
    })
    wsClient.connect()
  })

  onUnmounted(() => {
    wsClient?.disconnect()
    wsClient = null
  })

  return { entries, loading, wsConnected }
}
