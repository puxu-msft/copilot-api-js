export interface HistoryPersistRetryConfig {
  readonly maxAttempts: number
  readonly backoffMs: number
  readonly maxBackoffMs: number
  readonly maxTotalMs: number
}
