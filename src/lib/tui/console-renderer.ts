// Console renderer - simple single-line output for each completed request
// Replaces Hono's default logger with cleaner, more informative output

import consola from "consola"

import type { RequestUpdate, TrackedRequest, TuiRenderer } from "./types"

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
 * Console renderer that shows request lifecycle
 * Start: METHOD /path model-name
 * Complete: METHOD /path 200 1.2s 1.5K/500 model-name
 */
export class ConsoleRenderer implements TuiRenderer {
  private activeRequests: Map<string, TrackedRequest> = new Map()
  private showActive: boolean

  constructor(options?: { showActive?: boolean }) {
    this.showActive = options?.showActive ?? true
  }

  onRequestStart(request: TrackedRequest): void {
    this.activeRequests.set(request.id, request)

    if (this.showActive) {
      const modelInfo = request.model ? ` ${request.model}` : ""
      const queueInfo =
        request.queuePosition !== undefined && request.queuePosition > 0 ?
          ` [q#${request.queuePosition}]`
        : ""
      consola.log(
        `[....] ${request.method} ${request.path}${modelInfo}${queueInfo}`,
      )
    }
  }

  onRequestUpdate(id: string, update: RequestUpdate): void {
    const request = this.activeRequests.get(id)
    if (!request) return

    // Apply updates
    Object.assign(request, update)

    // Show streaming status
    if (this.showActive && update.status === "streaming") {
      const modelInfo = request.model ? ` ${request.model}` : ""
      consola.log(
        `[<-->] ${request.method} ${request.path}${modelInfo} streaming...`,
      )
    }
  }

  onRequestComplete(request: TrackedRequest): void {
    this.activeRequests.delete(request.id)

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
    const content = `${prefix} ${request.method} ${request.path} ${status} ${duration}${tokensPart}${modelInfo}`

    if (isError) {
      const errorInfo = request.error ? `: ${request.error}` : ""
      consola.log(content + errorInfo)
    } else {
      consola.log(content)
    }
  }

  destroy(): void {
    this.activeRequests.clear()
  }
}
