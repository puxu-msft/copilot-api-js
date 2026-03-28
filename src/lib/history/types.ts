/** Supported API endpoint types */
export type EndpointType = "anthropic-messages" | "openai-chat-completions" | "openai-responses"

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

export interface TextContentBlock {
  type: "text"
  text: string
}

export interface ThinkingContentBlock {
  type: "thinking"
  thinking: string
  signature?: string
}

export interface ToolUseContentBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultTextBlock {
  type: "text"
  text: string
}

export interface ToolResultImageBlock {
  type: "image"
  source: ImageSource
}

export interface ToolResultContentBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | Array<ToolResultTextBlock | ToolResultImageBlock>
  is_error?: boolean
}

export type ImageSource =
  | {
      type: "base64"
      media_type: string
      data: string
    }
  | {
      type: "url"
      url: string
    }

export interface ImageContentBlock {
  type: "image"
  source: ImageSource
}

export interface ServerToolUseContentBlock {
  type: "server_tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface RedactedThinkingContentBlock {
  type: "redacted_thinking"
  data?: string
}

export interface WebSearchToolResultContentBlock {
  type: "web_search_tool_result"
  tool_use_id: string
  content: unknown
}

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
  sessionId: string
  timestamp: number
  endpoint: EndpointType
  durationMs?: number
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
    headers?: Record<string, string>
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
    headers?: Record<string, string>
  }
  sseEvents?: Array<SseEventRecord>
  pipelineInfo?: PipelineInfo
  attempts?: Array<{
    index: number
    strategy?: string
    durationMs: number
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
  entries: Array<HistoryEntry>
  sessions: Map<string, Session>
  currentSessionId: string
  maxEntries: number
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
  sessionId: string
  timestamp: number
  endpoint: EndpointType
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
