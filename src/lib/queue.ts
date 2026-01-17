import consola from "consola"

import type { State } from "./state"

/**
 * A queued request that wraps execute/resolve/reject callbacks.
 * Uses 'unknown' for the queue storage since we handle multiple different
 * request types in a single queue. Type safety is maintained at the
 * enqueue() boundary where T is known.
 */
interface QueuedRequest {
  execute: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

// Simple request queue for rate limiting
// Instead of rejecting requests, queue them and process sequentially
class RequestQueue {
  private queue: Array<QueuedRequest> = []
  private processing = false
  private lastRequestTime = 0

  async enqueue<T>(
    execute: () => Promise<T>,
    rateLimitSeconds: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Store the request with type-erased callbacks
      // Type safety is ensured because we control both the storage and retrieval
      const request: QueuedRequest = {
        execute,
        resolve: resolve as (value: unknown) => void,
        reject,
      }
      this.queue.push(request)

      if (this.queue.length > 1) {
        const position = this.queue.length
        const waitTime = Math.ceil((position - 1) * rateLimitSeconds)
        const log = waitTime > 10 ? consola.warn : consola.info
        log(
          `Rate limit: request queued (position ${position}, ~${waitTime}s wait)`,
        )
      }

      void this.processQueue(rateLimitSeconds)
    })
  }

  private async processQueue(rateLimitSeconds: number): Promise<void> {
    if (this.processing) return
    this.processing = true

    while (this.queue.length > 0) {
      const now = Date.now()
      const elapsedMs = now - this.lastRequestTime
      const requiredMs = rateLimitSeconds * 1000

      if (this.lastRequestTime > 0 && elapsedMs < requiredMs) {
        const waitMs = requiredMs - elapsedMs
        const waitSec = Math.ceil(waitMs / 1000)
        const log = waitSec > 10 ? consola.warn : consola.info
        log(`Rate limit: waiting ${waitSec}s before next request...`)
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }

      const request = this.queue.shift()
      if (!request) break

      this.lastRequestTime = Date.now()

      try {
        const result = await request.execute()
        request.resolve(result)
      } catch (error) {
        request.reject(error)
      }
    }

    this.processing = false
  }

  get length(): number {
    return this.queue.length
  }
}

const requestQueue = new RequestQueue()

/**
 * Execute a request with rate limiting via queue.
 * Requests are queued and processed sequentially at the configured rate.
 */
export async function executeWithRateLimit<T>(
  state: State,
  execute: () => Promise<T>,
): Promise<T> {
  // If no rate limit configured, execute immediately
  if (state.rateLimitSeconds === undefined) {
    return execute()
  }

  return requestQueue.enqueue(execute, state.rateLimitSeconds)
}

export { requestQueue }
