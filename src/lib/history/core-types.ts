/** Supported API endpoint types. */
export type EndpointType = "anthropic-messages" | "openai-chat-completions" | "openai-responses" | "gemini-generate-content"

/** Lifecycle state shared by rich history records and narrow read projections. */
export type RequestLifecycleState = "pending" | "executing" | "streaming" | "completed" | "failed" | "aborted" | "interrupted"

export interface QueryOptions {
  /** Canonical operation kind. Default generation; `all` includes bypass operations. */
  operationKind?: "generation" | "count_tokens" | "embeddings" | "responses_ws" | "all"
  cursor?: string
  limit?: number
  direction?: "older" | "newer"
  model?: string
  endpoint?: EndpointType
  success?: boolean
  /** Exact lifecycle-state filter. When both are present, this takes precedence over `success`. */
  state?: RequestLifecycleState
  /** Exclude active in-flight entries from the merged result. */
  terminalOnly?: boolean
  from?: number
  to?: number
  search?: string
  sessionId?: string
  /** Filter to a specific subagent id. */
  agentId?: string
  /** Filter to the main agent only. `agentId` wins when both are present. */
  mainAgentOnly?: boolean
  /** Filter to records produced by a specific process. */
  pid?: number
}

export interface HistoryStats {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  abortedRequests: number
  interruptedRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  averageDurationMs: number
  modelDistribution: Record<string, number>
  endpointDistribution: Record<string, number>
  recentActivity: Array<{ hour: string; count: number }>
  activeSessions: number
}

/** Per-session aggregate row over ready terminal V3 summary rows. */
export interface SessionSummary {
  sessionId: string
  requestCount: number
  /** Distinct subagents only; main-agent rows have a NULL agent id. */
  agentCount: number
  /** Fresh input plus cache-read and cache-creation tokens. */
  inputTokens: number
  outputTokens: number
  firstStartedAt: number
  lastStartedAt: number
  completed: number
  failed: number
  /** Aborted plus interrupted terminal entries. */
  aborted: number
  models: Array<string>
  firstPreview: string
  preview: string
}

export interface EntrySummary {
  id: string
  operationKind?: "generation" | "count_tokens" | "embeddings" | "responses_ws"
  sessionId?: string
  agentId?: string
  rawPath?: string
  startedAt: number
  endedAt?: number
  endpoint: EndpointType
  state?: RequestLifecycleState
  active?: boolean
  /** Recent terminal has not reached durable V3 storage, or its bounded writer attempt failed. */
  durability?: "pending" | "failed"
  pinned?: boolean
  lastUpdatedAt?: number
  queueWaitMs?: number
  historyAdmissionWaitMs?: number
  attemptCount?: number
  currentStrategy?: string
  pid?: number
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
  timing?: { operation?: { source: "canonical" | "storage-commit-upper-bound" | "terminal-log-rounded" | "unavailable" } }
  requestBytes?: number
  responseBytes?: number
  multiplier?: number
  previewText: string
  responsePreviewText: string
}

export interface SummaryResult {
  entries: Array<EntrySummary>
  total: number
  nextCursor: string | null
  prevCursor: string | null
}
