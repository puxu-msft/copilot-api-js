import type { Ref } from "vue"

import type { EntrySummary, HistoryEntry, HistoryStats } from "@/types"

import { WSClient } from "@/api/ws"

interface UseHistoryWSOptions {
  entries: Ref<Array<EntrySummary>>
  prevCursor: Ref<string | null>
  total: Ref<number>
  stats: Ref<HistoryStats | null>
  selectedEntry: Ref<HistoryEntry | null>
  wsConnected: Ref<boolean>
  pageSize: number
  refresh: () => Promise<void>
  selectEntry: (id: string) => Promise<void>
}

export interface HistoryRealtimeState {
  init: () => void
  destroy: () => void
}

export function useHistoryWS({
  entries,
  prevCursor,
  total,
  stats,
  selectedEntry,
  wsConnected,
  pageSize,
  refresh,
  selectEntry,
}: UseHistoryWSOptions): HistoryRealtimeState {
  let wsClient: WSClient | null = null

  function handleEntryAdded(summary: EntrySummary): void {
    if (prevCursor.value === null) {
      entries.value = [summary, ...entries.value.slice(0, pageSize - 1)]
      total.value++
    }
  }

  function handleEntryUpdated(summary: EntrySummary): void {
    const idx = entries.value.findIndex((e) => e.id === summary.id)
    if (idx !== -1) {
      entries.value = entries.value.map((e, i) => (i === idx ? summary : e))
    }
    if (selectedEntry.value?.id === summary.id) {
      void selectEntry(summary.id)
    }
  }

  function handleStatsUpdated(newStats: HistoryStats): void {
    stats.value = newStats
  }

  function init(): void {
    void refresh()

    wsClient = new WSClient({
      topics: ["history"],
      onEntryAdded: handleEntryAdded,
      onEntryUpdated: handleEntryUpdated,
      onStatsUpdated: handleStatsUpdated,
      onHistoryCleared: () => void refresh(),
      onSessionDeleted: () => void refresh(),
      onStatusChange: (connected) => {
        wsConnected.value = connected
      },
    })
    wsClient.connect()
  }

  function destroy(): void {
    wsClient?.disconnect()
    wsClient = null
  }

  return {
    init,
    destroy,
  }
}
