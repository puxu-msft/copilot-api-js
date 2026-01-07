// Request tracker - manages request state independently of rendering

import type { RequestUpdate, TrackedRequest, TuiRenderer } from "./types"

// Simple ID generator
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

class RequestTracker {
  private requests: Map<string, TrackedRequest> = new Map()
  private renderer: TuiRenderer | null = null
  private completedQueue: Array<TrackedRequest> = []
  private historySize = 5
  private completedDisplayMs = 2000

  setRenderer(renderer: TuiRenderer | null): void {
    this.renderer = renderer
  }

  setOptions(options: {
    historySize?: number
    completedDisplayMs?: number
  }): void {
    if (options.historySize !== undefined) {
      this.historySize = options.historySize
    }
    if (options.completedDisplayMs !== undefined) {
      this.completedDisplayMs = options.completedDisplayMs
    }
  }

  /**
   * Start tracking a new request
   * Returns the tracking ID
   */
  startRequest(method: string, path: string, model: string): string {
    const id = generateId()
    const request: TrackedRequest = {
      id,
      method,
      path,
      model,
      startTime: Date.now(),
      status: "executing",
    }

    this.requests.set(id, request)
    this.renderer?.onRequestStart(request)

    return id
  }

  /**
   * Update request status
   */
  updateRequest(id: string, update: RequestUpdate): void {
    const request = this.requests.get(id)
    if (!request) return

    if (update.status !== undefined) request.status = update.status
    if (update.statusCode !== undefined) request.statusCode = update.statusCode
    if (update.durationMs !== undefined) request.durationMs = update.durationMs
    if (update.inputTokens !== undefined)
      request.inputTokens = update.inputTokens
    if (update.outputTokens !== undefined)
      request.outputTokens = update.outputTokens
    if (update.error !== undefined) request.error = update.error
    if (update.queuePosition !== undefined)
      request.queuePosition = update.queuePosition

    this.renderer?.onRequestUpdate(id, update)
  }

  /**
   * Mark request as completed
   */
  completeRequest(
    id: string,
    statusCode: number,
    usage?: { inputTokens: number; outputTokens: number },
  ): void {
    const request = this.requests.get(id)
    if (!request) return

    request.status =
      statusCode >= 200 && statusCode < 400 ? "completed" : "error"
    request.statusCode = statusCode
    request.durationMs = Date.now() - request.startTime

    if (usage) {
      request.inputTokens = usage.inputTokens
      request.outputTokens = usage.outputTokens
    }

    this.renderer?.onRequestComplete(request)

    // Move to completed queue
    this.requests.delete(id)
    this.completedQueue.push(request)

    // Trim completed queue
    while (this.completedQueue.length > this.historySize) {
      this.completedQueue.shift()
    }

    // Schedule removal from display after delay
    setTimeout(() => {
      const idx = this.completedQueue.indexOf(request)
      if (idx !== -1) {
        this.completedQueue.splice(idx, 1)
      }
    }, this.completedDisplayMs)
  }

  /**
   * Mark request as failed with error
   */
  failRequest(id: string, error: string): void {
    const request = this.requests.get(id)
    if (!request) return

    request.status = "error"
    request.error = error
    request.durationMs = Date.now() - request.startTime

    this.renderer?.onRequestComplete(request)

    this.requests.delete(id)
    this.completedQueue.push(request)

    while (this.completedQueue.length > this.historySize) {
      this.completedQueue.shift()
    }
  }

  /**
   * Get all active requests
   */
  getActiveRequests(): Array<TrackedRequest> {
    return Array.from(this.requests.values())
  }

  /**
   * Get recently completed requests
   */
  getCompletedRequests(): Array<TrackedRequest> {
    return [...this.completedQueue]
  }

  /**
   * Get request by ID
   */
  getRequest(id: string): TrackedRequest | undefined {
    return this.requests.get(id)
  }

  /**
   * Clear all tracked requests
   */
  clear(): void {
    this.requests.clear()
    this.completedQueue = []
  }
}

// Singleton instance
export const requestTracker = new RequestTracker()
