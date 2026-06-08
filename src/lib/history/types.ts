import type {
  //
  Base64ImageSource,
  ImageBlockParam,
  RedactedThinkingBlockParam,
  ServerToolUseBlockParam,
  TextBlockParam,
  ThinkingBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
  URLImageSource,
  WebSearchToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages"

/** Supported API endpoint types */
export type EndpointType = "anthropic-messages" | "openai-chat-completions" | "openai-responses" | "gemini-generate-content"

export type RequestTransport = "http" | "upstream-ws" | "upstream-ws-fallback"
export type RequestLifecycleState = "pending" | "executing" | "streaming" | "completed" | "failed"

/** Message types for full content storage */
export interface MessageContent {
  role: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: string | Array<any> | null
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

// ============================================================================
// Content block aliases — authoritative definitions live in the Anthropic SDK.
// History stores request-shaped data (no `caller`, optional `citations`), so
// aliases point at the `*Param` variants rather than the response-side `*Block`
// types. See `@anthropic-ai/sdk/resources/messages` for field-level docs.
// ============================================================================

export type TextContentBlock = TextBlockParam
export type ThinkingContentBlock = ThinkingBlockParam
export type ToolUseContentBlock = ToolUseBlockParam
export type RedactedThinkingContentBlock = RedactedThinkingBlockParam
export type ServerToolUseContentBlock = ServerToolUseBlockParam
export type WebSearchToolResultContentBlock = WebSearchToolResultBlockParam
export type ToolResultContentBlock = ToolResultBlockParam
export type ImageContentBlock = ImageBlockParam
export type ImageSource = Base64ImageSource | URLImageSource

/** Member type used inside `ToolResultBlockParam.content`. */
export type ToolResultTextBlock = TextBlockParam
/** Member type used inside `ToolResultBlockParam.content`. */
export type ToolResultImageBlock = ImageBlockParam

/**
 * Catch-all server-side tool result envelope.
 *
 * The Anthropic SDK ships several concrete server tool result types
 * (`WebSearchToolResultBlock`, `CodeExecutionToolResultBlock`,
 * `ToolSearchToolResultBlock`, …) — but every Copilot integration that records
 * one of these into history just needs the common `{ type, tool_use_id, content }`
 * shape. Retained per principle 5 ("any 与具体类型并存"): kept loose so consumers
 * that don't care about the concrete variant don't need to discriminate.
 */
export interface ServerToolResultContentBlock {
  type: string
  tool_use_id: string
  content: unknown
}

export type ContentBlock =
  | TextContentBlock
  | ThinkingContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock
  | ImageContentBlock
  | ServerToolUseContentBlock
  | RedactedThinkingContentBlock
  | WebSearchToolResultContentBlock
  | ServerToolResultContentBlock

export interface ToolDefinition {
  name: string
  description?: string
  type?: string
  input_schema?: Record<string, unknown>
  [key: string]: unknown
}

export interface TruncationInfo {
  wasTruncated: boolean
  removedMessageCount: number
  originalTokens: number
  compactedTokens: number
  processingTimeMs: number
}

export interface SanitizationInfo {
  totalBlocksRemoved: number
  orphanedToolUseCount: number
  orphanedToolResultCount: number
  fixedNameCount: number
  emptyTextBlocksRemoved: number
  systemReminderRemovals: number
}

export interface PreprocessInfo {
  strippedReadTagCount: number
  dedupedToolCallCount: number
}

export interface SseEventRecord {
  offsetMs: number
  type: string
  data: unknown
}

export interface PipelineInfo {
  truncation?: TruncationInfo
  preprocessing?: PreprocessInfo
  sanitization?: Array<SanitizationInfo>
  messageMapping?: Array<number>
}

export interface WarningMessage {
  code: string
  message: string
}

export interface UsageData {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens_details?: { reasoning_tokens: number }
}

export interface SystemBlock {
  type: "text"
  text: string
  cache_control?: { type: string } | null
}

export interface HistoryEntry {
  id: string
  sessionId?: string
  rawPath?: string
  startedAt: number
  endedAt?: number
  endpoint: EndpointType
  state?: RequestLifecycleState
  active?: boolean
  lastUpdatedAt?: number
  queueWaitMs?: number
  attemptCount?: number
  currentStrategy?: string
  durationMs?: number
  transport?: RequestTransport
  warningMessages?: Array<WarningMessage>
  request: {
    model?: string
    messages?: Array<MessageContent>
    stream?: boolean
    tools?: Array<ToolDefinition>
    system?: string | Array<SystemBlock>
    max_tokens?: number
    temperature?: number
    thinking?: unknown
  }
  effectiveRequest?: {
    model?: string
    format?: EndpointType
    messageCount?: number
    messages?: Array<MessageContent>
    system?: string | Array<SystemBlock>
    payload?: unknown
  }
  wireRequest?: {
    model?: string
    format?: EndpointType
    messageCount?: number
    messages?: Array<MessageContent>
    system?: string | Array<SystemBlock>
    payload?: unknown
  }
  response?: {
    success: boolean
    model: string
    usage: UsageData
    stop_reason?: string
    error?: string
    status?: number
    content: MessageContent | null
    rawBody?: string
  }
  /** HTTP headers captured at each leg of the proxy pipeline */
  httpHeaders?: {
    /** Client → Proxy (inbound request) */
    inboundRequest?: Record<string, string>
    /** Proxy → Upstream API (outbound request) */
    outboundRequest?: Record<string, string>
    /** Upstream API → Proxy (outbound response) */
    outboundResponse?: Record<string, string>
    /** Proxy → Client (inbound response) — reserved for future use */
    inboundResponse?: Record<string, string>
  }
  sseEvents?: Array<SseEventRecord>
  pipelineInfo?: PipelineInfo
  attempts?: Array<{
    index: number
    strategy?: string
    durationMs: number
    transport?: RequestTransport
    error?: string
    truncation?: TruncationInfo
    sanitization?: SanitizationInfo
    effectiveMessageCount?: number
  }>
}

export interface Session {
  id: string
  startTime: number
  lastActivity: number
  requestCount: number
  totalInputTokens: number
  totalOutputTokens: number
  models: Array<string>
  endpoints: Array<EndpointType>
  toolsUsed?: Array<string>
}

export interface HistoryState {
  enabled: boolean
}

export interface QueryOptions {
  cursor?: string
  limit?: number
  direction?: "older" | "newer"
  model?: string
  endpoint?: EndpointType
  success?: boolean
  from?: number
  to?: number
  search?: string
  sessionId?: string
}

export interface HistoryResult {
  entries: Array<HistoryEntry>
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface CursorResult<T> {
  entries: Array<T>
  total: number
  nextCursor: string | null
  prevCursor: string | null
}

export interface SessionResult {
  sessions: Array<Session>
  total: number
}

export interface HistoryStats {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  averageDurationMs: number
  modelDistribution: Record<string, number>
  endpointDistribution: Record<string, number>
  recentActivity: Array<{ hour: string; count: number }>
  activeSessions: number
}

export interface EntrySummary {
  id: string
  sessionId?: string
  rawPath?: string
  startedAt: number
  endedAt?: number
  endpoint: EndpointType
  state?: RequestLifecycleState
  active?: boolean
  lastUpdatedAt?: number
  queueWaitMs?: number
  attemptCount?: number
  currentStrategy?: string
  requestModel?: string
  stream?: boolean
  messageCount: number
  responseModel?: string
  responseSuccess?: boolean
  responseError?: string
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  durationMs?: number
  previewText: string
  searchText: string
}

export interface SummaryResult {
  entries: Array<EntrySummary>
  total: number
  nextCursor: string | null
  prevCursor: string | null
}
