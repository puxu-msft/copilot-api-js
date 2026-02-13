// ═══ Content Blocks ═══

export interface TextContentBlock {
  type: 'text'
  text: string
}

export interface ThinkingContentBlock {
  type: 'thinking'
  thinking: string
}

export interface RedactedThinkingContentBlock {
  type: 'redacted_thinking'
  data: string
}

export interface ToolUseContentBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultContentBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | ContentBlock[]
  is_error?: boolean
}

export interface ImageContentBlock {
  type: 'image'
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
}

export type ContentBlock =
  | TextContentBlock
  | ThinkingContentBlock
  | RedactedThinkingContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock
  | ImageContentBlock
  | { type: string; [key: string]: unknown } // fallback for unknown types

// ═══ System Blocks ═══

export interface SystemBlock {
  type: string
  text: string
  cache_control?: { type: string }
}

// ═══ Messages ═══

export interface MessageContent {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | ContentBlock[]
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

export interface ToolDefinition {
  name: string
  description?: string
}

// ═══ Truncation / Sanitization / Rewrite ═══

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
  rewrittenMessages?: MessageContent[]
  rewrittenSystem?: string | SystemBlock[]
  messageMapping?: number[]
}

// ═══ Request / Response ═══

export interface UsageData {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface HistoryEntry {
  id: string
  sessionId: string
  timestamp: number
  endpoint: 'anthropic' | 'openai'

  request: {
    model: string
    messages: MessageContent[]
    stream: boolean
    tools?: ToolDefinition[]
    max_tokens?: number
    temperature?: number
    system?: string | SystemBlock[]
  }

  response?: {
    success: boolean
    model: string
    usage: UsageData
    stop_reason?: string
    error?: string
    content: MessageContent | null
    toolCalls?: Array<{
      id: string
      name: string
      input: string | Record<string, unknown>
    }>
  }

  truncation?: TruncationInfo
  rewrites?: RewriteInfo
  durationMs?: number
}

// ═══ Session ═══

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

// ═══ API Responses ═══

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
  recentActivity: Array<{ hour: string; count: number }>
  activeSessions: number
}

// ═══ Query Options ═══

export interface QueryOptions {
  page?: number
  limit?: number
  model?: string
  endpoint?: 'anthropic' | 'openai'
  success?: boolean
  from?: number
  to?: number
  search?: string
  sessionId?: string
}
