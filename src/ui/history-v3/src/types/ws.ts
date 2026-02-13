import type { HistoryEntry, HistoryStats } from './index'

export type WSMessageType = 'entry_added' | 'entry_updated' | 'stats_updated' | 'connected'

export interface WSMessage {
  type: WSMessageType
  data: unknown
  timestamp: number
}

export interface WSEntryMessage extends WSMessage {
  type: 'entry_added' | 'entry_updated'
  data: HistoryEntry
}

export interface WSStatsMessage extends WSMessage {
  type: 'stats_updated'
  data: HistoryStats
}

export interface WSConnectedMessage extends WSMessage {
  type: 'connected'
  data: { clientCount: number }
}
