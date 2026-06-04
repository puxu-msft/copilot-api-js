/**
 * History module — request history persistence + WebSocket
 *
 * Re-exports all history-related types and functions.
 */

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
// Store (persistence and query)
export {
  clearHistory,
  deleteSession,
  exportHistory,
  finalizeEntry,
  getCurrentSession,
  getEntry,
  getHistory,
  getHistorySummaries,
  getInFlightEntry,
  getSession,
  getSessionEntries,
  getSessionIdFromHeaders,
  getSessions,
  getStats,
  getSummary,
  historyState,
  initHistory,
  insertEntry,
  isHistoryEnabled,
  listInFlightEntries,
  listInFlightSummaries,
  registerResponseSession,
  resolveResponseSessionId,
  setHistoryMaxEntries,
  shutdownHistory,
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
  RequestLifecycleState,
  RequestTransport,
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
