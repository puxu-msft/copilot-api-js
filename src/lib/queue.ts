import consola from "consola"

import type { State } from "./state"

interface QueuedRequest<T> {
  execute: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

// Simple request queue for rate limiting
// Instead of rejecting requests, queue them and process sequentially
class RequestQueue {
  private queue: Array<QueuedRequest<unknown>> = []
  private processing = false
  private lastRequestTime = 0

  async enqueue<T>(
    execute: () => Promise<T>,
    rateLimitSeconds: number,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        execute: execute as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      })

      if (this.queue.length > 1) {
        const waitTime = Math.ceil((this.queue.length - 1) * rateLimitSeconds)
        consola.info(
          `Request queued. Position: ${this.queue.length}, estimated wait: ${waitTime}s`,
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
        consola.debug(`Rate limit: waiting ${Math.ceil(waitMs / 1000)}s`)
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
