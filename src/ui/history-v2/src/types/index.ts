export interface TruncationInfo {
  removedMessageCount: number
  originalTokens: number
  compactedTokens: number
  processingTimeMs: number
}

export interface SanitizationInfo {
  removedBlockCount: number
  systemReminderRemovals: number
}

export interface RewriteInfo {
  truncation?: TruncationInfo
  sanitization?: SanitizationInfo
  rewrittenMessages?: Message[]
  rewrittenSystem?: string | SystemBlock[]
}

// History entry types
export interface HistoryEntry {
  id: string
  timestamp: number
  sessionId: string
  endpoint: 'anthropic' | 'openai'
  durationMs?: number
  request: RequestData
  response?: ResponseData
  truncation?: TruncationInfo
  rewrites?: RewriteInfo
}

export interface RequestData {
  model: string
  stream?: boolean
  max_tokens?: number
  temperature?: number
  system?: string | SystemBlock[]
  messages: Message[]
  tools?: ToolDefinition[]
}

export interface SystemBlock {
  type: 'text'
  text: string
  cache_control?: { type: string }
}

export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string | ContentBlock[]
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image' | 'thinking' | 'redacted_thinking'
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | ContentBlock[]
  source?: ImageSource
  is_error?: boolean
}

export interface ImageSource {
  type: 'base64'
  media_type: string
  data: string
}

export interface ToolDefinition {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

export interface ResponseData {
  success: boolean
  model?: string
  content?: ContentBlock[]
  stop_reason?: string
  error?: string
  usage?: UsageData
  toolCalls?: ToolCall[]
}

export interface UsageData {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface ToolCall {
  id: string
  type: string
  function?: {
    name: string
    arguments: string
  }
}

// Session types
export interface Session {
  id: string
  startTime: number
  lastActivity: number
  requestCount: number
  totalInputTokens: number
  totalOutputTokens: number
  models: string[]
  endpoint?: string
  toolsUsed?: string[]
}

// API response types
export interface HistoryResult {
  entries: HistoryEntry[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface SessionResult {
  sessions: Session[]
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
  activeSessions: number
  recentActivity: number[]
}

// Query options
export interface QueryOptions {
  page?: number
  limit?: number
  sessionId?: string
  endpoint?: string
  success?: boolean
  search?: string
  from?: number
  to?: number
  model?: string
}

// WebSocket message types
export interface WSMessage {
  type: 'entry_added' | 'entry_updated' | 'stats_updated' | 'session_updated'
  data: unknown
}

export interface WSEntryAddedMessage extends WSMessage {
  type: 'entry_added'
  data: HistoryEntry
}

export interface WSEntryUpdatedMessage extends WSMessage {
  type: 'entry_updated'
  data: HistoryEntry
}

export interface WSStatsUpdatedMessage extends WSMessage {
  type: 'stats_updated'
  data: HistoryStats
}
