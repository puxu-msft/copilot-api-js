/** TUI logger - manages request log entries independently of rendering */

import { state } from "~/lib/state"
import { generateId } from "~/lib/utils"

import type { RequestUpdate, TuiLogEntry, TuiRenderer } from "./types"

interface StartRequestOptions {
  method: string
  path: string
  model?: string
  isHistoryAccess?: boolean
  requestBodySize?: number
}

export class TuiLogger {
  private entries: Map<string, TuiLogEntry> = new Map()
  private renderer: TuiRenderer | null = null
  private completedQueue: Array<TuiLogEntry> = []
  private completedTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private historySize = 5
  private completedDisplayMs = 2000

  setRenderer(renderer: TuiRenderer | null): void {
    this.renderer = renderer
  }

  setOptions(options: { historySize?: number; completedDisplayMs?: number }): void {
    if (options.historySize !== undefined) {
      this.historySize = options.historySize
    }
    if (options.completedDisplayMs !== undefined) {
      this.completedDisplayMs = options.completedDisplayMs
    }
  }

  /**
   * Start tracking a new request
   * Returns the log entry ID
   */
  startRequest(options: StartRequestOptions): string {
    const id = generateId()
    const entry: TuiLogEntry = {
      id,
      method: options.method,
      path: options.path,
      model: options.model,
      startTime: Date.now(),
      status: "executing",
      isHistoryAccess: options.isHistoryAccess,
      requestBodySize: options.requestBodySize,
    }

    this.entries.set(id, entry)
    this.renderer?.onRequestStart(entry)

    return id
  }

  /**
   * Update request status
   */
  updateRequest(id: string, update: RequestUpdate): void {
    const entry = this.entries.get(id)
    if (!entry) return

    if (update.model !== undefined) {
      entry.model = update.model
      const multiplier = state.models?.data.find((m) => m.id === update.model)?.billing?.multiplier
      if (multiplier !== undefined) entry.multiplier = multiplier
    }
    if (update.status !== undefined) entry.status = update.status
    if (update.statusCode !== undefined) entry.statusCode = update.statusCode
    if (update.durationMs !== undefined) entry.durationMs = update.durationMs
    if (update.inputTokens !== undefined) entry.inputTokens = update.inputTokens
    if (update.outputTokens !== undefined) entry.outputTokens = update.outputTokens
    if (update.cacheReadInputTokens !== undefined) entry.cacheReadInputTokens = update.cacheReadInputTokens
    if (update.cacheCreationInputTokens !== undefined) entry.cacheCreationInputTokens = update.cacheCreationInputTokens
    if (update.estimatedTokens !== undefined) entry.estimatedTokens = update.estimatedTokens
    if (update.error !== undefined) entry.error = update.error
    if (update.queuePosition !== undefined) entry.queuePosition = update.queuePosition
    if (update.queueWaitMs !== undefined) entry.queueWaitMs = update.queueWaitMs
    if (update.tags) {
      entry.tags ??= []
      for (const tag of update.tags) {
        if (!entry.tags.includes(tag)) entry.tags.push(tag)
      }
    }

    this.renderer?.onRequestUpdate(id, update)
  }

  /**
   * Mark request as completed
   */
  completeRequest(id: string, statusCode: number, usage?: { inputTokens: number; outputTokens: number }): void {
    const entry = this.entries.get(id)
    if (!entry) return

    entry.status =
      // 101 = WebSocket upgrade (Switching Protocols), also a success
      statusCode === 101 || (statusCode >= 200 && statusCode < 400) ? "completed" : "error"
    entry.statusCode = statusCode
    entry.durationMs = Date.now() - entry.startTime

    if (usage) {
      entry.inputTokens = usage.inputTokens
      entry.outputTokens = usage.outputTokens
    }

    this.renderer?.onRequestComplete(entry)

    // Move to completed queue
    this.entries.delete(id)
    this.completedQueue.push(entry)

    // Trim completed queue
    while (this.completedQueue.length > this.historySize) {
      const removed = this.completedQueue.shift()
      if (removed) {
        // Clear the timeout for the removed entry
        const timeoutId = this.completedTimeouts.get(removed.id)
        if (timeoutId) {
          clearTimeout(timeoutId)
          this.completedTimeouts.delete(removed.id)
        }
      }
    }

    // Schedule removal from display after delay
    const timeoutId = setTimeout(() => {
      const idx = this.completedQueue.indexOf(entry)
      if (idx !== -1) {
        this.completedQueue.splice(idx, 1)
      }
      this.completedTimeouts.delete(id)
    }, this.completedDisplayMs)
    this.completedTimeouts.set(id, timeoutId)
  }

  /**
   * Mark request as failed with error
   */
  failRequest(id: string, error: string): void {
    const entry = this.entries.get(id)
    if (!entry) return

    entry.status = "error"
    entry.error = error
    entry.durationMs = Date.now() - entry.startTime

    this.renderer?.onRequestComplete(entry)

    // Move to completed queue
    this.entries.delete(id)
    this.completedQueue.push(entry)

    // Trim completed queue (same cleanup as completeRequest)
    while (this.completedQueue.length > this.historySize) {
      const removed = this.completedQueue.shift()
      if (removed) {
        const timeoutId = this.completedTimeouts.get(removed.id)
        if (timeoutId) {
          clearTimeout(timeoutId)
          this.completedTimeouts.delete(removed.id)
        }
      }
    }

    // Schedule removal from display after delay
    const timeoutId = setTimeout(() => {
      const idx = this.completedQueue.indexOf(entry)
      if (idx !== -1) {
        this.completedQueue.splice(idx, 1)
      }
      this.completedTimeouts.delete(id)
    }, this.completedDisplayMs)
    this.completedTimeouts.set(id, timeoutId)
  }

  /**
   * Get all active entries
   */
  getActiveRequests(): Array<TuiLogEntry> {
    return Array.from(this.entries.values())
  }

  /**
   * Get recently completed entries
   */
  getCompletedRequests(): Array<TuiLogEntry> {
    return [...this.completedQueue]
  }

  /**
   * Get entry by ID
   */
  getRequest(id: string): TuiLogEntry | undefined {
    return this.entries.get(id)
  }

  /**
   * Clear all entries and pending timeouts
   */
  clear(): void {
    this.entries.clear()
    this.completedQueue = []
    // Clear all pending timeouts
    for (const timeoutId of this.completedTimeouts.values()) {
      clearTimeout(timeoutId)
    }
    this.completedTimeouts.clear()
  }

  /**
   * Destroy the logger and its renderer.
   * Called during graceful shutdown to clean up terminal state (e.g. footer).
   */
  destroy(): void {
    this.clear()
    this.renderer?.destroy()
    this.renderer = null
  }
}

/** Singleton instance */
export const tuiLogger = new TuiLogger()
