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

/** Outcome passed to finishRequest to mark a request as completed or failed */
export interface RequestOutcome {
  statusCode?: number
  error?: string
  usage?: { inputTokens: number; outputTokens: number }
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
      const multiplier = state.modelIndex.get(update.model)?.billing?.multiplier
      if (multiplier !== undefined) entry.multiplier = multiplier
    }
    if (update.clientModel !== undefined) entry.clientModel = update.clientModel
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
    if (update.streamBytesIn !== undefined) entry.streamBytesIn = update.streamBytesIn
    if (update.streamEventsIn !== undefined) entry.streamEventsIn = update.streamEventsIn
    if (update.streamBlockType !== undefined) entry.streamBlockType = update.streamBlockType
    if (update.tags) {
      entry.tags ??= []
      for (const tag of update.tags) {
        if (!entry.tags.includes(tag)) entry.tags.push(tag)
      }
    }

    this.renderer?.onRequestUpdate(id, update)
  }

  /**
   * Mark a request as finished (completed or failed).
   *
   * Determines final status from the outcome:
   * - `error` present → "error"
   * - `statusCode` in success range (101, 2xx, 3xx) → "completed"
   * - `statusCode` outside success range → "error"
   * - Neither → "completed" (e.g. streaming success with no HTTP status)
   *
   * Safe to call multiple times for the same ID — second call is a no-op.
   * This eliminates the dual-path race between middleware and context consumer.
   */
  finishRequest(id: string, outcome: RequestOutcome): void {
    const entry = this.entries.get(id)
    if (!entry) return

    // Determine final status
    if (outcome.error) {
      entry.status = "error"
      entry.error = outcome.error
    } else if (outcome.statusCode !== undefined) {
      const sc = outcome.statusCode
      entry.status = sc === 101 || (sc >= 200 && sc < 400) ? "completed" : "error"
    } else {
      entry.status = "completed"
    }

    if (outcome.statusCode !== undefined) entry.statusCode = outcome.statusCode
    if (outcome.usage) {
      entry.inputTokens = outcome.usage.inputTokens
      entry.outputTokens = outcome.usage.outputTokens
    }
    entry.durationMs = Date.now() - entry.startTime

    this.renderer?.onRequestComplete(entry)
    this.moveToCompleted(id, entry)
  }

  // ─── Completed queue management ───

  /** Move entry from active to completed queue with auto-cleanup */
  private moveToCompleted(id: string, entry: TuiLogEntry): void {
    this.entries.delete(id)
    this.completedQueue.push(entry)

    // Trim queue to max history size
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

  // ─── Queries ───

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
   * Get entry by ID (only active/in-flight entries)
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
