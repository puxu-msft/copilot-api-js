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
  getCurrentSession,
  getEntry,
  getHistory,
  getHistorySummaries,
  getSession,
  getSessionEntries,
  getSessions,
  getStats,
  getSummary,
  historyState,
  initHistory,
  insertEntry,
  isHistoryEnabled,
  setHistoryMaxEntries,
  updateEntry,
} from "./store"

export type {
  ContentBlock,
  EndpointType,
  EntrySummary,
  HistoryEntry,
  HistoryResult,
  HistoryState,
  HistoryStats,
  ImageContentBlock,
  ImageSource,
  MessageContent,
  PreprocessInfo,
  QueryOptions,
  RedactedThinkingContentBlock,
  RewriteInfo,
  SanitizationInfo,
  ServerToolUseContentBlock,
  Session,
  SessionResult,
  SummaryResult,
  SystemBlock,
  TextContentBlock,
  ThinkingContentBlock,
  ToolDefinition,
  ToolResultContentBlock,
  ToolResultImageBlock,
  ToolResultTextBlock,
  ToolUseContentBlock,
  TruncationInfo,
  UsageData,
  WebSearchToolResultContentBlock,
} from "./store"

// WebSocket
export {
  addClient,
  closeAllClients,
  getClientCount,
  notifyEntryAdded,
  notifyEntryUpdated,
  notifyHistoryCleared,
  notifySessionDeleted,
  notifyStatsUpdated,
  removeClient,
} from "./ws"
export type { WSMessage, WSMessageType } from "./ws"
