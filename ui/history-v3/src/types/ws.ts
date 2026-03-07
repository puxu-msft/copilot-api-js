/**
 * WebSocket message types for History UI.
 *
 * Base types re-exported from backend, discriminated subtypes defined locally.
 */
import type { EntrySummary, HistoryStats } from "./index"

export type { WSMessage, WSMessageType } from "~backend/lib/history/ws"

// ─── Frontend-only discriminated subtypes ───

export interface WSEntryMessage {
  type: "entry_added" | "entry_updated"
  data: EntrySummary
  timestamp: number
}

export interface WSStatsMessage {
  type: "stats_updated"
  data: HistoryStats
  timestamp: number
}

export interface WSConnectedMessage {
  type: "connected"
  data: { clientCount: number }
  timestamp: number
}

export interface WSHistoryClearedMessage {
  type: "history_cleared"
  data: null
  timestamp: number
}

export interface WSSessionDeletedMessage {
  type: "session_deleted"
  data: { sessionId: string }
  timestamp: number
}
