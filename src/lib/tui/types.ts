/** TUI types for request tracking and display */

export type RequestStatus = "queued" | "executing" | "streaming" | "completed" | "error"

export interface TuiLogEntry {
  id: string
  method: string
  path: string
  model?: string
  /** Original model name from client request (before resolution/override) */
  clientModel?: string
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

  // ─── Streaming metrics (updated in real-time during streaming) ───

  /** Cumulative bytes received from upstream during streaming */
  streamBytesIn?: number
  /** Number of SSE events received from upstream during streaming */
  streamEventsIn?: number
  /** Current content block type being streamed (e.g. "thinking", "text", "tool_use") */
  streamBlockType?: string
}

export interface RequestUpdate {
  model?: string
  /** Original model name from client request (before resolution/override) */
  clientModel?: string
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

  // ─── Streaming metrics ───

  /** Cumulative bytes received from upstream during streaming */
  streamBytesIn?: number
  /** Number of SSE events received from upstream during streaming */
  streamEventsIn?: number
  /** Current content block type being streamed (e.g. "thinking", "text", "tool_use") */
  streamBlockType?: string
}

/**
 * Per-retry event carried alongside the in-flight entry.
 *
 * Emitted by `executeRequestPipeline` for every retry-eligible failure AFTER
 * the budget gate has accepted the retry. The entry itself stays "in-flight";
 * the retry line is a side-band notification that an attempt failed and is
 * being retried, slotted into the log stream BEFORE the eventual `[ OK ]` /
 * `[FAIL]` outcome line.
 */
export interface RetryInfo {
  /** 1-based: "the Nth attempt just failed" (attempt 1 = first failure). */
  attempt: number
  /** Strategy name that decided to retry (e.g. "network-retry", "auto-truncate"). */
  strategyName: string
  /** HTTP status code from the classified ApiError (non-optional in our taxonomy). */
  statusCode: number
  /** Error message from the classified ApiError. */
  error: string
  /** Backoff delay before the next attempt, in milliseconds. Omitted/0 = no wait. */
  waitMs?: number
  /** True if this retry draws from the learning-probe budget (e.g. beta enumeration). */
  learning?: boolean
}

export interface TuiRenderer {
  /** Called when a new request starts */
  onRequestStart(entry: TuiLogEntry): void

  /** Called when request status updates */
  onRequestUpdate(id: string, update: RequestUpdate): void

  /**
   * Called when an attempt failed and the pipeline decided to retry.
   * Optional — renderers that don't care can omit it.
   * Entry remains in-flight; do not transition state.
   */
  onRequestRetry?(entry: TuiLogEntry, info: RetryInfo): void

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
