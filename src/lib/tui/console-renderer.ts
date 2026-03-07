/**
 * Console renderer - simple single-line output for each completed request.
 * Replaces Hono's default logger with cleaner, more informative output.
 */

import consola from "consola"
import pc from "picocolors"

import type { RequestUpdate, TuiLogEntry, TuiRenderer } from "./types"

import { formatBytes, formatDuration, formatStreamInfo, formatTime, formatTokens } from "./format"

// ANSI escape codes for cursor control
const CLEAR_LINE = "\x1b[2K\r"

/**
 * Console renderer that shows request lifecycle with apt-get style footer
 *
 * Log format:
 * - Start: [....] HH:MM:SS METHOD /path model-name (debug only, dim)
 * - Streaming: [<-->] HH:MM:SS METHOD /path model-name streaming... (dim)
 * - Complete: [ OK ] HH:MM:SS 200 POST /path model-name (3x) 1.2s ↑12.3KB ↓45.6KB ↑1.5K+300 ↓500 (colored)
 * - Error: [FAIL] HH:MM:SS 500 POST /path model-name (3x) 1.2s: error message (red)
 *
 * Color scheme for completed requests:
 * - Prefix: green (success) / red (error)
 * - Time: dim
 * - Method: white
 * - Path: white
 * - Model: magenta
 * - Status: green (success) / red (error)
 * - Duration: yellow
 * - Tokens: cyan (req/res info)
 *
 * Features:
 * - Start lines only shown in debug mode (--verbose)
 * - Streaming lines are dim (less important)
 * - /history API requests are always dim
 * - Sticky footer shows active requests with model and elapsed time
 * - Footer auto-refreshes every second while requests are in-flight
 * - Intercepts consola output to properly handle footer
 */
export class ConsoleRenderer implements TuiRenderer {
  private activeRequests: Map<string, TuiLogEntry> = new Map()
  private showActive: boolean
  private footerVisible = false
  private isTTY: boolean
  private originalReporters: Array<unknown> = []
  private footerTimer: ReturnType<typeof setInterval> | null = null

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
        // Trim trailing whitespace/newlines to prevent blank lines
        // (e.g. citty's runMain passes "\n" as a separate arg on errors)
        const message = logObj.args
          .map((arg) => {
            if (typeof arg === "string") return arg
            // Error objects have non-enumerable properties, JSON.stringify gives "{}"
            if (arg instanceof Error) {
              return arg.stack ?? arg.message
            }
            return JSON.stringify(arg)
          })
          .join(" ")
          .trimEnd()

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
   * Get log prefix based on log type (includes timestamp)
   */
  private getLogPrefix(type: string): string {
    const time = pc.dim(formatTime())

    switch (type) {
      case "error":
      case "fatal": {
        return `${pc.red("[ERR ]")} ${time}`
      }
      case "warn": {
        return `${pc.yellow("[WARN]")} ${time}`
      }
      case "info": {
        return `${pc.cyan("[INFO]")} ${time}`
      }
      case "success": {
        return `${pc.green("[SUCC]")} ${time}`
      }
      case "debug": {
        return `${pc.gray("[DBG ]")} ${time}`
      }
      default: {
        return time
      }
    }
  }

  // ─── Footer (active request status line) ───

  /**
   * Build footer text showing per-request model and elapsed time.
   *
   * Single:  [<-->] POST /v1/messages claude-sonnet-4 3.2s ↓12.3KB 42ev [thinking]
   * Multi:   [<-->] claude-sonnet-4 5.2s ↓456KB 120ev [thinking] | claude-haiku-3 0.3s
   */
  private getFooterText(): string {
    const activeCount = this.activeRequests.size
    if (activeCount === 0) return ""

    const now = Date.now()

    if (activeCount === 1) {
      const req = this.activeRequests.values().next().value
      if (!req) return "" // should never happen when activeCount === 1
      const elapsed = formatDuration(now - req.startTime)
      const model = req.model ? ` ${req.model}` : ""
      const streamInfo = formatStreamInfo(req)
      return pc.dim(`[<-->] ${req.method} ${req.path}${model} ${elapsed}${streamInfo}`)
    }

    // Multiple requests — compact: model elapsed stream-info | model elapsed stream-info
    const items = Array.from(this.activeRequests.values()).map((req) => {
      const elapsed = formatDuration(now - req.startTime)
      const label = req.model || `${req.method} ${req.path}`
      const streamInfo = formatStreamInfo(req)
      return `${label} ${elapsed}${streamInfo}`
    })
    return pc.dim(`[<-->] ${items.join(" | ")}`)
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

  /** Start periodic footer refresh (every 100ms) to keep elapsed time current */
  private startFooterTimer(): void {
    if (this.footerTimer || !this.isTTY) return
    this.footerTimer = setInterval(() => {
      if (this.activeRequests.size > 0) {
        this.renderFooter()
      } else {
        this.stopFooterTimer()
      }
    }, 100)
    // Don't prevent process exit
    this.footerTimer.unref()
  }

  /** Stop periodic footer refresh */
  private stopFooterTimer(): void {
    if (this.footerTimer) {
      clearInterval(this.footerTimer)
      this.footerTimer = null
    }
  }

  /**
   * Format a complete log line with colored parts
   *
   * Format: [xxxx] HH:mm:ss <status> <method> <path> <model> (<multiplier>x) <duration> ↑<reqSize> ↓<respSize> ↑<inTokens>+<cache> ↓<outTokens>
   */
  private formatLogLine(parts: {
    prefix: string
    time: string
    method: string
    path: string
    model?: string
    /** Original model name from client (shown when different from resolved model) */
    clientModel?: string
    multiplier?: number
    status?: number
    duration?: string
    requestBodySize?: number
    responseBodySize?: number
    inputTokens?: number
    outputTokens?: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
    queueWait?: string
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
      clientModel,
      multiplier,
      status,
      duration,
      requestBodySize,
      responseBodySize,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      queueWait,
      extra,
      isError,
      isDim,
    } = parts

    if (isDim) {
      const modelPart = model ? ` ${model}` : ""
      const extraPart = extra ? ` ${extra}` : ""
      return pc.dim(`${prefix} ${time} ${method} ${path}${modelPart}${extraPart}`)
    }

    // Colored lines: each part has its own color
    const coloredPrefix = isError ? pc.red(prefix) : pc.green(prefix)
    const coloredTime = pc.dim(time)
    let coloredStatus: string | undefined
    if (status !== undefined) {
      coloredStatus = isError ? pc.red(String(status)) : pc.green(String(status))
    }
    const coloredMethod = pc.white(method)
    const coloredPath = pc.white(path)

    // Show "clientModel → model" when client requested a different model name
    let coloredModel = ""
    if (model) {
      coloredModel =
        clientModel && clientModel !== model ?
          ` ${pc.dim(clientModel)} → ${pc.magenta(model)}`
        : pc.magenta(` ${model}`)
    }
    const coloredMultiplier = multiplier !== undefined ? pc.dim(` (${multiplier}x)`) : ""
    const coloredDuration = duration ? ` ${pc.yellow(duration)}` : ""
    const coloredQueueWait = queueWait ? ` ${pc.dim(`(queued ${queueWait})`)}` : ""

    // req/resp body sizes with ↑↓ arrows
    let sizeInfo = ""
    if (model) {
      const reqSize = requestBodySize !== undefined ? `↑${formatBytes(requestBodySize)}` : ""
      const respSize = responseBodySize !== undefined ? `↓${formatBytes(responseBodySize)}` : ""
      const parts = [reqSize, respSize].filter(Boolean).join(" ")
      if (parts) sizeInfo = ` ${pc.dim(parts)}`
    }

    // in-tokens/out-tokens (with cache breakdown)
    let tokenInfo = ""
    if (model && (inputTokens !== undefined || outputTokens !== undefined)) {
      tokenInfo = ` ${formatTokens(inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens)}`
    }

    let extraPart = ""
    if (extra) {
      extraPart = isError ? pc.red(extra) : extra
    }

    const statusAndMethod = coloredStatus ? `${coloredStatus} ${coloredMethod}` : coloredMethod

    return `${coloredPrefix} ${coloredTime} ${statusAndMethod} ${coloredPath}${coloredModel}${coloredMultiplier}${coloredDuration}${coloredQueueWait}${sizeInfo}${tokenInfo}${extraPart}`
  }

  /**
   * Print a log line with proper footer handling
   */
  private printLog(message: string): void {
    this.clearFooterForLog()
    process.stdout.write(message + "\n")
    this.renderFooter()
  }

  onRequestStart(request: TuiLogEntry): void {
    this.activeRequests.set(request.id, request)
    this.startFooterTimer()

    // Only show start line in debug mode (consola.level >= 5)
    if (this.showActive && consola.level >= 5) {
      const message = this.formatLogLine({
        prefix: "[....]",
        time: formatTime(),
        method: request.method,
        path: request.path,
        model: request.model,
        extra:
          request.queuePosition !== undefined && request.queuePosition > 0 ? `[q#${request.queuePosition}]` : undefined,
        isDim: true,
      })
      this.printLog(message)
    }
  }

  onRequestUpdate(id: string, update: RequestUpdate): void {
    const request = this.activeRequests.get(id)
    if (!request) return

    Object.assign(request, update)
  }

  onRequestComplete(request: TuiLogEntry): void {
    this.activeRequests.delete(request.id)

    // Stop timer when no more active requests
    if (this.activeRequests.size === 0) {
      this.stopFooterTimer()
    }

    // Skip completed log line for history access (only errors are shown)
    if (request.isHistoryAccess && request.status !== "error") {
      this.renderFooter()
      return
    }

    const status = request.statusCode
    const isError = request.status === "error" || (status !== undefined && status >= 400)

    // Only show queue wait if it's significant (> 100ms)
    const queueWait = request.queueWaitMs && request.queueWaitMs > 100 ? formatDuration(request.queueWaitMs) : undefined

    // Build extra text from tags and error
    // Tags are supplementary metadata — dim the entire group
    const tagStr = !isError && request.tags?.length ? pc.dim(` (${request.tags.join(", ")})`) : ""
    const errorStr = isError && request.error ? `: ${request.error}` : ""
    const extra = tagStr + errorStr || undefined

    const message = this.formatLogLine({
      prefix: isError ? "[FAIL]" : "[ OK ]",
      time: formatTime(),
      method: request.method,
      path: request.path,
      model: request.model,
      clientModel: request.clientModel,
      multiplier: request.multiplier,
      status,
      duration: formatDuration(request.durationMs ?? 0),
      queueWait,
      requestBodySize: request.requestBodySize,
      responseBodySize: request.streamBytesIn,
      inputTokens: request.inputTokens,
      outputTokens: request.outputTokens,
      cacheReadInputTokens: request.cacheReadInputTokens,
      cacheCreationInputTokens: request.cacheCreationInputTokens,
      extra,
      isError,
    })
    this.printLog(message)
  }

  destroy(): void {
    this.stopFooterTimer()
    if (this.footerVisible && this.isTTY) {
      process.stdout.write(CLEAR_LINE)
      this.footerVisible = false
    }
    this.activeRequests.clear()

    // Restore original reporters
    if (this.originalReporters.length > 0) {
      consola.setReporters(this.originalReporters as Parameters<typeof consola.setReporters>[0])
    }
  }
}
