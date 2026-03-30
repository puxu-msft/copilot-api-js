/**
 * History module — request history persistence + WebSocket
 *
 * Re-exports all history-related types and functions.
 */

// Memory pressure monitor
export { startMemoryPressureMonitor, stopMemoryPressureMonitor } from "./memory-pressure"

// Store (persistence and query)
export {
  clearHistory,
  deleteSession,
  evictOldestEntries,
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
  CursorResult,
  EndpointType,
  EntrySummary,
  HistoryEntry,
  HistoryResult,
  HistoryState,
  HistoryStats,
  ImageContentBlock,
  ImageSource,
  MessageContent,
  PipelineInfo,
  PreprocessInfo,
  QueryOptions,
  RedactedThinkingContentBlock,
  SanitizationInfo,
  ServerToolResultContentBlock,
  ServerToolUseContentBlock,
  Session,
  SessionResult,
  SseEventRecord,
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
} from "../ws"

export type { WSMessage, WSMessageType } from "../ws"
