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
 * - Start: [....] HH:MM:SS METHOD /path model-name (debug only, dim)
 * - Streaming: [<-->] HH:MM:SS METHOD /path model-name streaming... (dim)
 * - Complete: [ OK ] HH:MM:SS METHOD /path model-name 200 1.2s 1.5K/500 (colored)
 * - Error: [FAIL] HH:MM:SS METHOD /path model-name 500 1.2s: error message (red)
 *
 * Color scheme for completed requests:
 * - Prefix: green (success) / red (error)
 * - Time: dim
 * - Method: cyan
 * - Path: white
 * - Model: magenta
 * - Status: green (success) / red (error)
 * - Duration: yellow
 * - Tokens: blue
 *
 * Features:
 * - Start lines only shown in debug mode (--verbose)
 * - Streaming lines are dim (less important)
 * - /history API requests are always dim
 * - Sticky footer shows active request count
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
   * Format a complete log line with colored parts
   */
  private formatLogLine(parts: {
    prefix: string
    time: string
    method: string
    path: string
    model?: string
    status?: number
    duration?: string
    tokens?: string
    extra?: string
    isError?: boolean
    isDim?: boolean
  }): string {
    const {
      prefix,
      time,
      method,
      path,
      model,
      status,
      duration,
      tokens,
      extra,
      isError,
      isDim,
    } = parts

    if (isDim) {
      // Dim lines: all gray
      const modelPart = model ? ` ${model}` : ""
      const extraPart = extra ? ` ${extra}` : ""
      return pc.dim(
        `${prefix} ${time} ${method} ${path}${modelPart}${extraPart}`,
      )
    }

    // Colored lines: each part has its own color
    const coloredPrefix = isError ? pc.red(prefix) : pc.green(prefix)
    const coloredTime = pc.dim(time)
    const coloredMethod = pc.cyan(method)
    const coloredPath = pc.white(path)
    const coloredModel = model ? pc.magenta(` ${model}`) : ""

    let result = `${coloredPrefix} ${coloredTime} ${coloredMethod} ${coloredPath}${coloredModel}`

    if (status !== undefined) {
      const coloredStatus =
        isError ? pc.red(String(status)) : pc.green(String(status))
      result += ` ${coloredStatus}`
    }

    if (duration) {
      result += ` ${pc.yellow(duration)}`
    }

    if (tokens) {
      result += ` ${pc.blue(tokens)}`
    }

    if (extra) {
      result += isError ? pc.red(extra) : extra
    }

    return result
  }

  /**
   * Print a log line with proper footer handling
   */
  private printLog(message: string): void {
    this.clearFooterForLog()
    process.stdout.write(message + "\n")
    this.renderFooter()
  }

  onRequestStart(request: TrackedRequest): void {
    this.activeRequests.set(request.id, request)

    // Only show start line in debug mode (consola.level >= 5)
    if (this.showActive && consola.level >= 5) {
      const message = this.formatLogLine({
        prefix: "[....]",
        time: formatTime(),
        method: request.method,
        path: request.path,
        model: request.model,
        extra:
          request.queuePosition !== undefined && request.queuePosition > 0 ?
            `[q#${request.queuePosition}]`
          : undefined,
        isDim: true,
      })
      this.printLog(message)
    }
  }

  onRequestUpdate(id: string, update: RequestUpdate): void {
    const request = this.activeRequests.get(id)
    if (!request) return

    Object.assign(request, update)

    if (this.showActive && update.status === "streaming") {
      const message = this.formatLogLine({
        prefix: "[<-->]",
        time: formatTime(),
        method: request.method,
        path: request.path,
        model: request.model,
        extra: "streaming...",
        isDim: true,
      })
      this.printLog(message)
    }
  }

  onRequestComplete(request: TrackedRequest): void {
    this.activeRequests.delete(request.id)

    const status = request.statusCode ?? 0
    const isError = request.status === "error" || status >= 400
    const tokens =
      request.model ?
        formatTokens(request.inputTokens, request.outputTokens)
      : undefined

    const message = this.formatLogLine({
      prefix: isError ? "[FAIL]" : "[ OK ]",
      time: formatTime(),
      method: request.method,
      path: request.path,
      model: request.model,
      status,
      duration: formatDuration(request.durationMs ?? 0),
      tokens,
      extra: isError && request.error ? `: ${request.error}` : undefined,
      isError,
      isDim: request.isHistoryAccess,
    })
    this.printLog(message)
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
