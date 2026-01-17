import consola from "consola"

/**
 * Adaptive Rate Limiter
 *
 * Normal mode: Full speed, no delay between requests
 * Rate-limited mode: Queue requests and process with exponential backoff
 * Gradual recovery: After recovery, slowly ramp up speed before full speed
 *
 * Mode transitions:
 * - Normal → Rate-limited: When a 429 error is detected
 * - Rate-limited → Recovering: After recovery timeout OR consecutive successes
 * - Recovering → Normal: After gradual speedup completes
 *
 * Features:
 * - Exponential backoff: Retry delays double each time (10s → 20s → 40s...)
 * - Retry-After support: Uses server-provided wait time if available
 * - Gradual recovery: Slowly ramps up speed after leaving rate-limited mode
 */

export interface AdaptiveRateLimiterConfig {
  /** Base interval for retries, doubles with each retry (default: 10s) */
  baseRetryIntervalSeconds: number
  /** Maximum retry interval cap (default: 120s) */
  maxRetryIntervalSeconds: number
  /** Interval between requests in rate-limited mode (default: 10s) */
  requestIntervalSeconds: number
  /** Time after which to attempt recovery to normal mode (default: 10 minutes) */
  recoveryTimeoutMinutes: number
  /** Number of consecutive successes needed to recover (default: 5) */
  consecutiveSuccessesForRecovery: number
  /** Gradual recovery steps: intervals to use before full speed (default: [5, 2, 1, 0]) */
  gradualRecoverySteps: Array<number>
}

const DEFAULT_CONFIG: AdaptiveRateLimiterConfig = {
  baseRetryIntervalSeconds: 10,
  maxRetryIntervalSeconds: 120,
  requestIntervalSeconds: 10,
  recoveryTimeoutMinutes: 10,
  consecutiveSuccessesForRecovery: 5,
  gradualRecoverySteps: [5, 2, 1, 0], // 5s → 2s → 1s → full speed
}

interface QueuedRequest<T> {
  execute: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
  retryCount: number
  /** Server-provided retry delay from Retry-After header */
  retryAfterSeconds?: number
  /** Timestamp when request was enqueued */
  enqueuedAt: number
}

/** Result wrapper that includes queue wait time */
export interface RateLimitedResult<T> {
  result: T
  /** Time spent waiting in queue (ms), 0 if not queued */
  queueWaitMs: number
}

type RateLimiterMode = "normal" | "rate-limited" | "recovering"

/**
 * Adaptive rate limiter that switches between normal, rate-limited, and recovering modes
 * based on API responses.
 */
export class AdaptiveRateLimiter {
  private config: AdaptiveRateLimiterConfig
  private mode: RateLimiterMode = "normal"
  private queue: Array<QueuedRequest<unknown>> = []
  private processing = false
  private rateLimitedAt: number | null = null
  private consecutiveSuccesses = 0
  private lastRequestTime = 0
  /** Current step in gradual recovery (index into gradualRecoverySteps) */
  private recoveryStepIndex = 0

  constructor(config: Partial<AdaptiveRateLimiterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Execute a request with adaptive rate limiting.
   * Returns a promise that resolves when the request succeeds.
   * The request will be retried automatically on 429 errors.
   */
  async execute<T>(fn: () => Promise<T>): Promise<RateLimitedResult<T>> {
    if (this.mode === "normal") {
      return this.executeInNormalMode(fn)
    }
    if (this.mode === "recovering") {
      return this.executeInRecoveringMode(fn)
    }
    return this.enqueue(fn)
  }

  /**
   * Check if an error is a rate limit error (429) and extract Retry-After if available
   */
  isRateLimitError(error: unknown): {
    isRateLimit: boolean
    retryAfter?: number
  } {
    if (error && typeof error === "object") {
      // Check HTTPError
      if ("status" in error && error.status === 429) {
        // Try to extract Retry-After from response headers or body
        const retryAfter = this.extractRetryAfter(error)
        return { isRateLimit: true, retryAfter }
      }
      // Check nested error structure from Copilot
      if ("responseText" in error && typeof error.responseText === "string") {
        try {
          const parsed: unknown = JSON.parse(error.responseText)
          if (
            parsed
            && typeof parsed === "object"
            && "error" in parsed
            && parsed.error
            && typeof parsed.error === "object"
            && "code" in parsed.error
            && parsed.error.code === "rate_limited"
          ) {
            return { isRateLimit: true }
          }
        } catch {
          // Not JSON, ignore
        }
      }
    }
    return { isRateLimit: false }
  }

  /**
   * Extract Retry-After value from error response
   */
  private extractRetryAfter(error: unknown): number | undefined {
    if (!error || typeof error !== "object") return undefined

    // Check responseText for JSON with retry_after field
    if ("responseText" in error && typeof error.responseText === "string") {
      try {
        const parsed: unknown = JSON.parse(error.responseText)
        if (
          parsed
          && typeof parsed === "object"
          && "retry_after" in parsed
          && typeof parsed.retry_after === "number"
        ) {
          return parsed.retry_after
        }
        // Also check nested error.retry_after
        if (
          parsed
          && typeof parsed === "object"
          && "error" in parsed
          && parsed.error
          && typeof parsed.error === "object"
          && "retry_after" in parsed.error
          && typeof parsed.error.retry_after === "number"
        ) {
          return parsed.error.retry_after
        }
      } catch {
        // Not JSON, ignore
      }
    }

    return undefined
  }

  /**
   * Execute in normal mode - full speed
   */
  private async executeInNormalMode<T>(
    fn: () => Promise<T>,
  ): Promise<RateLimitedResult<T>> {
    try {
      const result = await fn()
      return { result, queueWaitMs: 0 }
    } catch (error) {
      const { isRateLimit, retryAfter } = this.isRateLimitError(error)
      if (isRateLimit) {
        this.enterRateLimitedMode()
        // Queue this request for retry instead of failing
        return this.enqueue(fn, retryAfter)
      }
      throw error
    }
  }

  /**
   * Execute in recovering mode - gradual speedup
   */
  private async executeInRecoveringMode<T>(
    fn: () => Promise<T>,
  ): Promise<RateLimitedResult<T>> {
    const startTime = Date.now()
    const currentInterval =
      this.config.gradualRecoverySteps[this.recoveryStepIndex] ?? 0

    // Wait for the current recovery interval
    if (currentInterval > 0) {
      const now = Date.now()
      const elapsedMs = now - this.lastRequestTime
      const requiredMs = currentInterval * 1000

      if (this.lastRequestTime > 0 && elapsedMs < requiredMs) {
        const waitMs = requiredMs - elapsedMs
        await this.sleep(waitMs)
      }
    }

    this.lastRequestTime = Date.now()

    try {
      const result = await fn()

      // Success - advance recovery step
      this.recoveryStepIndex++
      if (this.recoveryStepIndex >= this.config.gradualRecoverySteps.length) {
        this.completeRecovery()
      } else {
        const nextInterval =
          this.config.gradualRecoverySteps[this.recoveryStepIndex] ?? 0
        consola.info(
          `[RateLimiter] Recovery step ${this.recoveryStepIndex}/${this.config.gradualRecoverySteps.length} `
            + `(next interval: ${nextInterval}s)`,
        )
      }

      const queueWaitMs = Date.now() - startTime
      return { result, queueWaitMs }
    } catch (error) {
      const { isRateLimit, retryAfter } = this.isRateLimitError(error)
      if (isRateLimit) {
        // Back to rate-limited mode
        consola.warn(
          "[RateLimiter] Hit rate limit during recovery, returning to rate-limited mode",
        )
        this.enterRateLimitedMode()
        return this.enqueue(fn, retryAfter)
      }
      throw error
    }
  }

  /**
   * Enter rate-limited mode
   */
  private enterRateLimitedMode(): void {
    if (this.mode === "rate-limited") return

    this.mode = "rate-limited"
    this.rateLimitedAt = Date.now()
    this.consecutiveSuccesses = 0

    consola.warn(
      `[RateLimiter] Entering rate-limited mode. `
        + `Requests will be queued with exponential backoff (base: ${this.config.baseRetryIntervalSeconds}s).`,
    )
  }

  /**
   * Check if we should try to recover to normal mode
   */
  private shouldAttemptRecovery(): boolean {
    // Check consecutive successes
    if (
      this.consecutiveSuccesses >= this.config.consecutiveSuccessesForRecovery
    ) {
      consola.info(
        `[RateLimiter] ${this.consecutiveSuccesses} consecutive successes. Starting gradual recovery.`,
      )
      return true
    }

    // Check timeout
    if (this.rateLimitedAt) {
      const elapsed = Date.now() - this.rateLimitedAt
      const timeout = this.config.recoveryTimeoutMinutes * 60 * 1000
      if (elapsed >= timeout) {
        consola.info(
          `[RateLimiter] ${this.config.recoveryTimeoutMinutes} minutes elapsed. Starting gradual recovery.`,
        )
        return true
      }
    }

    return false
  }

  /**
   * Start gradual recovery mode
   */
  private startGradualRecovery(): void {
    this.mode = "recovering"
    this.recoveryStepIndex = 0
    this.rateLimitedAt = null
    this.consecutiveSuccesses = 0

    const firstInterval = this.config.gradualRecoverySteps[0] ?? 0
    consola.info(
      `[RateLimiter] Starting gradual recovery (${this.config.gradualRecoverySteps.length} steps, `
        + `first interval: ${firstInterval}s)`,
    )
  }

  /**
   * Complete recovery to normal mode
   */
  private completeRecovery(): void {
    this.mode = "normal"
    this.recoveryStepIndex = 0

    consola.success("[RateLimiter] Recovery complete. Full speed enabled.")
  }

  /**
   * Enqueue a request for later execution
   */
  private enqueue<T>(
    fn: () => Promise<T>,
    retryAfterSeconds?: number,
  ): Promise<RateLimitedResult<T>> {
    return new Promise<RateLimitedResult<T>>((resolve, reject) => {
      const request: QueuedRequest<unknown> = {
        execute: fn as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        retryCount: 0,
        retryAfterSeconds,
        enqueuedAt: Date.now(),
      }

      this.queue.push(request)

      if (this.queue.length > 1) {
        const position = this.queue.length
        const estimatedWait =
          (position - 1) * this.config.requestIntervalSeconds
        consola.info(
          `[RateLimiter] Request queued (position ${position}, ~${estimatedWait}s wait)`,
        )
      }

      void this.processQueue()
    })
  }

  /**
   * Calculate retry interval with exponential backoff
   */
  private calculateRetryInterval(request: QueuedRequest<unknown>): number {
    // Use server-provided Retry-After if available
    if (
      request.retryAfterSeconds !== undefined
      && request.retryAfterSeconds > 0
    ) {
      return request.retryAfterSeconds
    }

    // Exponential backoff: base * 2^(retryCount-1), capped at max
    const backoff =
      this.config.baseRetryIntervalSeconds * Math.pow(2, request.retryCount)
    return Math.min(backoff, this.config.maxRetryIntervalSeconds)
  }

  /**
   * Process the queue
   */
  private async processQueue(): Promise<void> {
    if (this.processing) return
    this.processing = true

    while (this.queue.length > 0) {
      const request = this.queue[0]

      // Check if we should try recovery before processing
      if (this.shouldAttemptRecovery()) {
        this.startGradualRecovery()
        // Continue processing remaining queue items in recovering mode
        // But first, let the current queue drain
      }

      // Calculate wait time based on whether this is a retry or new request
      const now = Date.now()
      const elapsedMs = now - this.lastRequestTime
      const intervalSeconds =
        request.retryCount > 0 ?
          this.calculateRetryInterval(request)
        : this.config.requestIntervalSeconds
      const requiredMs = intervalSeconds * 1000

      if (this.lastRequestTime > 0 && elapsedMs < requiredMs) {
        const waitMs = requiredMs - elapsedMs
        const waitSec = Math.ceil(waitMs / 1000)
        consola.info(`[RateLimiter] Waiting ${waitSec}s before next request...`)
        await this.sleep(waitMs)
      }

      this.lastRequestTime = Date.now()

      try {
        const result = await request.execute()

        // Success!
        this.queue.shift()
        this.consecutiveSuccesses++
        // Clear retry-after on success
        request.retryAfterSeconds = undefined
        // Calculate queue wait time
        const queueWaitMs = Date.now() - request.enqueuedAt
        request.resolve({ result, queueWaitMs })

        if (this.mode === "rate-limited") {
          consola.info(
            `[RateLimiter] Request succeeded (${this.consecutiveSuccesses}/${this.config.consecutiveSuccessesForRecovery} for recovery)`,
          )
        }
      } catch (error) {
        const { isRateLimit, retryAfter } = this.isRateLimitError(error)
        if (isRateLimit) {
          // Still rate limited, retry with exponential backoff
          request.retryCount++
          request.retryAfterSeconds = retryAfter
          this.consecutiveSuccesses = 0
          this.rateLimitedAt = Date.now() // Reset timeout

          const nextInterval = this.calculateRetryInterval(request)
          const source =
            retryAfter ? "server Retry-After" : "exponential backoff"
          consola.warn(
            `[RateLimiter] Request failed with 429 (retry #${request.retryCount}). `
              + `Retrying in ${nextInterval}s (${source})...`,
          )
        } else {
          // Other error, fail this request and continue with queue
          this.queue.shift()
          request.reject(error)
        }
      }
    }

    this.processing = false

    // If queue is empty and we're in rate-limited mode, stay in that mode
    // until recovery conditions are met on next request
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Get current status for debugging/monitoring
   */
  getStatus(): {
    mode: RateLimiterMode
    queueLength: number
    consecutiveSuccesses: number
    rateLimitedAt: number | null
  } {
    return {
      mode: this.mode,
      queueLength: this.queue.length,
      consecutiveSuccesses: this.consecutiveSuccesses,
      rateLimitedAt: this.rateLimitedAt,
    }
  }
}

// Singleton instance
let rateLimiterInstance: AdaptiveRateLimiter | null = null

/**
 * Initialize the adaptive rate limiter with configuration
 */
export function initAdaptiveRateLimiter(
  config: Partial<AdaptiveRateLimiterConfig> = {},
): void {
  rateLimiterInstance = new AdaptiveRateLimiter(config)

  const baseRetry =
    config.baseRetryIntervalSeconds ?? DEFAULT_CONFIG.baseRetryIntervalSeconds
  const maxRetry =
    config.maxRetryIntervalSeconds ?? DEFAULT_CONFIG.maxRetryIntervalSeconds
  const interval =
    config.requestIntervalSeconds ?? DEFAULT_CONFIG.requestIntervalSeconds
  const recovery =
    config.recoveryTimeoutMinutes ?? DEFAULT_CONFIG.recoveryTimeoutMinutes
  const successes =
    config.consecutiveSuccessesForRecovery
    ?? DEFAULT_CONFIG.consecutiveSuccessesForRecovery
  const steps =
    config.gradualRecoverySteps ?? DEFAULT_CONFIG.gradualRecoverySteps

  consola.info(
    `[RateLimiter] Initialized (backoff: ${baseRetry}s-${maxRetry}s, `
      + `interval: ${interval}s, recovery: ${recovery}min or ${successes} successes, `
      + `gradual: [${steps.join("s, ")}s])`,
  )
}

/**
 * Get the rate limiter instance
 */
export function getAdaptiveRateLimiter(): AdaptiveRateLimiter | null {
  return rateLimiterInstance
}

/**
 * Execute a request with adaptive rate limiting.
 * If rate limiter is not initialized, executes immediately.
 * Returns the result along with queue wait time.
 */
export async function executeWithAdaptiveRateLimit<T>(
  fn: () => Promise<T>,
): Promise<RateLimitedResult<T>> {
  if (!rateLimiterInstance) {
    const result = await fn()
    return { result, queueWaitMs: 0 }
  }
  return rateLimiterInstance.execute(fn)
}
