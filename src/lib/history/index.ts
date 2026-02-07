/**
 * History module — request history persistence + WebSocket
 *
 * Re-exports all history-related types and functions.
 */

// Store (persistence and query)
export {
  clearHistory,
  deleteSession,
  exportHistory,
  getEntry,
  getHistory,
  getSession,
  getSessionEntries,
  getSessions,
  getStats,
  historyState,
  initHistory,
  isHistoryEnabled,
  recordRequest,
  recordResponse,
  recordRewrites,
  recordTruncation,
} from "./store"

export type {
  HistoryEntry,
  HistoryResult,
  HistoryState,
  HistoryStats,
  MessageContent,
  QueryOptions,
  RecordRequestParams,
  RecordResponseParams,
  RewriteInfo,
  SanitizationInfo,
  Session,
  SessionResult,
  ToolDefinition,
  TruncationInfo,
} from "./store"

// WebSocket
export {
  addClient,
  closeAllClients,
  getClientCount,
  notifyEntryAdded,
  notifyEntryUpdated,
  notifyStatsUpdated,
  removeClient,
} from "./ws"
export type { WSMessage, WSMessageType } from "./ws"
