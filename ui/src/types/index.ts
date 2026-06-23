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
  WarningMessage,
  WebSearchToolResultContentBlock,
} from "~backend/lib/history/store"

export type {
  //
  DimensionBreakdownSnapshot,
  DimensionKeySnapshot,
  DimensionSeriesPoint,
} from "~backend/lib/request-telemetry"
