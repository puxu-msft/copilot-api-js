// TUI types for request tracking and display

export type RequestStatus =
  | "queued"
  | "executing"
  | "streaming"
  | "completed"
  | "error"

export interface TrackedRequest {
  id: string
  method: string
  path: string
  model?: string
  startTime: number
  status: RequestStatus
  statusCode?: number
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  error?: string
  queuePosition?: number
  /** Whether this is a /history API access (displayed in gray) */
  isHistoryAccess?: boolean
}

export interface RequestUpdate {
  status?: RequestStatus
  statusCode?: number
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  error?: string
  queuePosition?: number
}

export interface TuiRenderer {
  /** Called when a new request starts */
  onRequestStart(request: TrackedRequest): void

  /** Called when request status updates */
  onRequestUpdate(id: string, update: RequestUpdate): void

  /** Called when request completes (success or error) */
  onRequestComplete(request: TrackedRequest): void

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
