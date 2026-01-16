// Console renderer - simple single-line output for each completed request
// Replaces Hono's default logger with cleaner, more informative output

import consola from "consola"
import pc from "picocolors"

import type { RequestUpdate, TrackedRequest, TuiRenderer } from "./types"

// ANSI escape codes for cursor control
const CLEAR_LINE = "\x1b[2K\r"

function formatTime(date: Date = new Date()): string {
  const h = String(date.getHours()).padStart(2, "0")
  const m = String(date.getMinutes()).padStart(2, "0")
  const s = String(date.getSeconds()).padStart(2, "0")
  return `${h}:${m}:${s}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function formatTokens(input?: number, output?: number): string {
  if (input === undefined || output === undefined) return "-"
  return `${formatNumber(input)}/${formatNumber(output)}`
}

/**
 * Console renderer that shows request lifecycle with apt-get style footer
 *
 * Log format:
 * - Start: [....] METHOD /path model-name
 * - Streaming: [<-->] METHOD /path model-name streaming...
 * - Complete: [ OK ] METHOD /path 200 1.2s 1.5K/500 model-name
 *
 * Features:
 * - /history API requests are displayed in gray (dim)
 * - Sticky footer shows active request count, updated in-place on the last line
 * - Footer disappears when all requests complete
 */
export class ConsoleRenderer implements TuiRenderer {
  private activeRequests: Map<string, TrackedRequest> = new Map()
  private showActive: boolean
  private footerVisible = false
  private isTTY: boolean

  constructor(options?: { showActive?: boolean }) {
    this.showActive = options?.showActive ?? true

    this.isTTY = process.stdout.isTTY
  }

  /**
   * Get footer text based on active request count
   */
  private getFooterText(): string {
    const activeCount = this.activeRequests.size
    if (activeCount === 0) return ""
    const plural = activeCount === 1 ? "" : "s"
    return pc.dim(`[....] ${activeCount} request${plural} in progress...`)
  }

  /**
   * Render footer in-place on current line (no newline)
   * Only works on TTY terminals
   */
  private renderFooter(): void {
    if (!this.isTTY) return

    const footerText = this.getFooterText()
    if (footerText) {
      process.stdout.write(CLEAR_LINE + footerText)
      this.footerVisible = true
    } else if (this.footerVisible) {
      process.stdout.write(CLEAR_LINE)
      this.footerVisible = false
    }
  }

  /**
   * Clear footer and prepare for log output
   */
  private clearFooterForLog(): void {
    if (this.footerVisible && this.isTTY) {
      process.stdout.write(CLEAR_LINE)
      this.footerVisible = false
    }
  }

  /**
   * Print a log line with proper footer handling
   * 1. Clear footer if visible
   * 2. Print log with newline
   * 3. Re-render footer on new line (no newline after footer)
   */
  private printLog(message: string, isGray = false): void {
    this.clearFooterForLog()

    // Print the log message
    if (isGray) {
      consola.log(pc.dim(message))
    } else {
      consola.log(message)
    }

    // Re-render footer after log (stays on its own line without newline)
    this.renderFooter()
  }

  onRequestStart(request: TrackedRequest): void {
    this.activeRequests.set(request.id, request)

    if (this.showActive) {
      const time = formatTime()
      const modelInfo = request.model ? ` ${request.model}` : ""
      const queueInfo =
        request.queuePosition !== undefined && request.queuePosition > 0 ?
          ` [q#${request.queuePosition}]`
        : ""
      const message = `${time} [....] ${request.method} ${request.path}${modelInfo}${queueInfo}`
      this.printLog(message, request.isHistoryAccess)
    }
  }

  onRequestUpdate(id: string, update: RequestUpdate): void {
    const request = this.activeRequests.get(id)
    if (!request) return

    // Apply updates
    Object.assign(request, update)

    // Show streaming status
    if (this.showActive && update.status === "streaming") {
      const time = formatTime()
      const modelInfo = request.model ? ` ${request.model}` : ""
      const message = `${time} [<-->] ${request.method} ${request.path}${modelInfo} streaming...`
      this.printLog(message, request.isHistoryAccess)
    }
  }

  onRequestComplete(request: TrackedRequest): void {
    this.activeRequests.delete(request.id)

    const time = formatTime()
    const status = request.statusCode ?? 0
    const duration = formatDuration(request.durationMs ?? 0)
    const tokens =
      request.model ?
        formatTokens(request.inputTokens, request.outputTokens)
      : ""
    const modelInfo = request.model ? ` ${request.model}` : ""

    const isError = request.status === "error" || status >= 400
    const prefix = isError ? "[FAIL]" : "[ OK ]"
    const tokensPart = tokens ? ` ${tokens}` : ""
    let content = `${time} ${prefix} ${request.method} ${request.path} ${status} ${duration}${tokensPart}${modelInfo}`

    if (isError) {
      const errorInfo = request.error ? `: ${request.error}` : ""
      content += errorInfo
    }

    this.printLog(content, request.isHistoryAccess)
  }

  destroy(): void {
    if (this.footerVisible && this.isTTY) {
      process.stdout.write(CLEAR_LINE)
      this.footerVisible = false
    }
    this.activeRequests.clear()
  }
}
