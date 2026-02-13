/** TUI types for request tracking and display */

export type RequestStatus = "queued" | "executing" | "streaming" | "completed" | "error"

export interface TuiLogEntry {
  id: string
  method: string
  path: string
  model?: string
  /** Billing multiplier for the model (e.g. 3 for opus, 0.33 for haiku) */
  multiplier?: number
  startTime: number
  status: RequestStatus
  statusCode?: number
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  /** Cache read input tokens (prompt cache hits) */
  cacheReadInputTokens?: number
  /** Cache creation input tokens (prompt cache writes) */
  cacheCreationInputTokens?: number
  /** HTTP request body size in bytes */
  requestBodySize?: number
  /** Internally estimated input token count (before sending to model) */
  estimatedTokens?: number
  error?: string
  queuePosition?: number
  /** Time spent waiting in rate-limit queue (ms) */
  queueWaitMs?: number
  /** Whether this is a /history API access (displayed in gray) */
  isHistoryAccess?: boolean
  /** Feature tags for display, e.g. ["truncated", "thinking"] */
  tags?: Array<string>
}

export interface RequestUpdate {
  model?: string
  status?: RequestStatus
  statusCode?: number
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  /** Cache read input tokens (prompt cache hits) */
  cacheReadInputTokens?: number
  /** Cache creation input tokens (prompt cache writes) */
  cacheCreationInputTokens?: number
  /** Internally estimated input token count (before sending to model) */
  estimatedTokens?: number
  error?: string
  queuePosition?: number
  /** Time spent waiting in rate-limit queue (ms) */
  queueWaitMs?: number
  /** Feature tags to append (additive, not replacement) */
  tags?: Array<string>
}

export interface TuiRenderer {
  /** Called when a new request starts */
  onRequestStart(entry: TuiLogEntry): void

  /** Called when request status updates */
  onRequestUpdate(id: string, update: RequestUpdate): void

  /** Called when request completes (success or error) */
  onRequestComplete(entry: TuiLogEntry): void

  /** Cleanup renderer resources */
  destroy(): void
}

export interface TuiOptions {
  /** Enable TUI mode (default: true if TTY) */
  enabled?: boolean

  /** Show completed requests in history (default: 5) */
  historySize?: number

  /** Minimum display time for completed requests in ms (default: 2000) */
  completedDisplayMs?: number
}
