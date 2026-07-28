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
  SearchResult,
  SearchResultRow,
  SearchSource,
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
} from "~backend/lib/history/types"

// Telemetry types moved out of the backend tree into the `telemetry` workspace
// package (monorepo split), so this one leg goes to the package rather than
// through `~backend/*`.
export type {
  //
  DimensionBreakdownSnapshot,
  DimensionKeySnapshot,
  DimensionSeriesPoint,
  HistogramSummary,
} from "@hsupu/ghc-proxy-telemetry"
