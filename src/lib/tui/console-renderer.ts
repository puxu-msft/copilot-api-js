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

function formatShortId(id: string): string {
  // Take last 5 characters for a short, unique identifier
  return id.slice(-5)
}

/**
 * Console renderer that shows request lifecycle with apt-get style footer
 *
 * Log format (status prefix first, then timestamp):
 * - Start: [....] HH:MM:SS METHOD /path #id model-name (dim)
 * - Streaming: [<-->] HH:MM:SS METHOD /path #id model-name streaming... (dim)
 * - Complete: [ OK ] HH:MM:SS METHOD /path #id model-name 200 1.2s 1.5K/500 (green)
 * - Error: [FAIL] HH:MM:SS METHOD /path #id model-name 500 1.2s: error message (red)
 *
 * Features:
 * - Start and streaming lines are dim (less important)
 * - Success lines are green, error lines are red
 * - /history API requests are always dim
 * - Sticky footer shows active request count, updated in-place on the last line
 * - Footer disappears when all requests complete
 * - Intercepts consola output to properly handle footer
 */
export class ConsoleRenderer implements TuiRenderer {
  private activeRequests: Map<string, TrackedRequest> = new Map()
  private showActive: boolean
  private footerVisible = false
  private isTTY: boolean
  private originalReporters: Array<unknown> = []

  constructor(options?: { showActive?: boolean }) {
    this.showActive = options?.showActive ?? true
    this.isTTY = process.stdout.isTTY

    // Install consola reporter that coordinates with footer
    this.installConsolaReporter()
  }

  /**
   * Install a custom consola reporter that coordinates with footer
   */
  private installConsolaReporter(): void {
    // Save original reporters
    this.originalReporters = [...consola.options.reporters]

    // Create a wrapper reporter that handles footer
    const footerAwareReporter = {
      log: (logObj: { args: Array<unknown>; type: string }) => {
        // Clear footer before any consola output
        this.clearFooterForLog()

        // Format and print the log message
        const message = logObj.args
          .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
          .join(" ")

        // Use appropriate formatting based on log type
        const prefix = this.getLogPrefix(logObj.type)
        if (prefix) {
          process.stdout.write(`${prefix} ${message}\n`)
        } else {
          process.stdout.write(`${message}\n`)
        }

        // Re-render footer after log
        this.renderFooter()
      },
    }

    consola.setReporters([footerAwareReporter])
  }

  /**
   * Get log prefix based on log type
   */
  private getLogPrefix(type: string): string {
    switch (type) {
      case "error":
      case "fatal": {
        return pc.red("✖")
      }
      case "warn": {
        return pc.yellow("⚠")
      }
      case "info": {
        return pc.cyan("ℹ")
      }
      case "success": {
        return pc.green("✔")
      }
      case "debug": {
        return pc.gray("●")
      }
      default: {
        return ""
      }
    }
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
   * Print a log line with proper footer handling and coloring
   * 1. Clear footer if visible
   * 2. Print log with newline
   * 3. Re-render footer on new line (no newline after footer)
   */
  private printLog(
    message: string,
    style: "dim" | "success" | "error" | "normal" = "normal",
  ): void {
    this.clearFooterForLog()

    // Print the log message directly to stdout to avoid recursion
    let formatted: string
    switch (style) {
      case "dim": {
        formatted = pc.dim(message)
        break
      }
      case "success": {
        formatted = pc.green(message)
        break
      }
      case "error": {
        formatted = pc.red(message)
        break
      }
      default: {
        formatted = message
      }
    }
    process.stdout.write(formatted + "\n")

    // Re-render footer after log (stays on its own line without newline)
    this.renderFooter()
  }

  onRequestStart(request: TrackedRequest): void {
    this.activeRequests.set(request.id, request)

    if (this.showActive) {
      const time = formatTime()
      const shortId = ` #${formatShortId(request.id)}`
      const modelInfo = request.model ? ` ${request.model}` : ""
      const queueInfo =
        request.queuePosition !== undefined && request.queuePosition > 0 ?
          ` [q#${request.queuePosition}]`
        : ""
      // Format: [PREFIX] TIME METHOD PATH #ID MODEL
      const message = `[....] ${time} ${request.method} ${request.path}${shortId}${modelInfo}${queueInfo}`
      // Start and streaming lines are dim (less important)
      this.printLog(message, "dim")
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
      const shortId = ` #${formatShortId(request.id)}`
      const modelInfo = request.model ? ` ${request.model}` : ""
      // Format: [PREFIX] TIME METHOD PATH #ID MODEL streaming...
      const message = `[<-->] ${time} ${request.method} ${request.path}${shortId}${modelInfo} streaming...`
      // Streaming lines are dim (less important)
      this.printLog(message, "dim")
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
    const shortId = ` #${formatShortId(request.id)}`
    const modelInfo = request.model ? ` ${request.model}` : ""

    const isError = request.status === "error" || status >= 400
    const prefix = isError ? "[FAIL]" : "[ OK ]"
    const tokensPart = tokens ? ` ${tokens}` : ""
    // Format: [PREFIX] TIME METHOD PATH #ID MODEL STATUS DURATION TOKENS
    let content = `${prefix} ${time} ${request.method} ${request.path}${shortId}${modelInfo} ${status} ${duration}${tokensPart}`

    if (isError) {
      const errorInfo = request.error ? `: ${request.error}` : ""
      content += errorInfo
    }

    // Success is green, error is red, history access is dim
    let style: "dim" | "success" | "error"
    if (request.isHistoryAccess) {
      style = "dim"
    } else if (isError) {
      style = "error"
    } else {
      style = "success"
    }
    this.printLog(content, style)
  }

  destroy(): void {
    if (this.footerVisible && this.isTTY) {
      process.stdout.write(CLEAR_LINE)
      this.footerVisible = false
    }
    this.activeRequests.clear()

    // Restore original reporters
    if (this.originalReporters.length > 0) {
      consola.setReporters(
        this.originalReporters as Parameters<typeof consola.setReporters>[0],
      )
    }
  }
}
