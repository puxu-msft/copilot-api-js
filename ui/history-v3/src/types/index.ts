/**
 * History V3 UI type definitions.
 *
 * All types are re-exported from the backend (single source of truth).
 */

export type {
  ContentBlock,
  CursorResult,
  EndpointType,
  EntrySummary,
  HistoryEntry,
  HistoryResult,
  HistoryStats,
  ImageContentBlock,
  ImageSource,
  MessageContent,
  PipelineInfo,
  PreprocessInfo,
  QueryOptions,
  RedactedThinkingContentBlock,
  SanitizationInfo,
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
} from "~backend/lib/history/store"
