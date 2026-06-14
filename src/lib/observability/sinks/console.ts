/**
 * Console sink — renders observability events as a single-line terminal log
 * stream with an active-request footer.
 *
 * Subscribes to:
 * - `request.created` / `request.model_resolved` / `request.state_changed`
 *   — track active requests; render `[....]` start line in debug mode.
 * - `request.feature_applied` / `request.stream_progress` — mutate active
 *   entry's display state (streaming bytes, feature tags).
 * - `request.attempt_failed { willRetry: true }` — render `[RETRY-n]` line
 *   (per-attempt retry visualization; the entry remains active).
 * - `request.completed` / `request.failed` / `request.aborted` — render
 *   `[ OK ]` / `[FAIL]` line and remove from active.
 * - `system.shutdown_phase_changed` / `system.rate_limit_state` — non-line
 *   side effects (no console output currently; reserved for future UX).
 *
 * Replaces `lib/tui/console-renderer.ts` (deleted in commit 4). ConsoleSink
 * is the authoritative stdout renderer for request lifecycle lines + footer.
 */

import consola from "consola"
import pc from "picocolors"

import type {
  //
  ObservabilityBus,
  ObservabilityEvent,
  RequestContextSnapshot,
} from "../index"
import type { LogLineParts } from "../projections/log-line"

import { assertNever } from "../index"
import {
  //
  formatDuration,
  formatStreamInfo,
  formatTime,
} from "../projections/format"
import { formatLogLine } from "../projections/log-line"

// ANSI escape code for "clear to end of line, return to column 0"
const CLEAR_LINE = "\x1b[2K\r"

/** Mutable per-request display state — replaces `TuiLogEntry`. */
interface ActiveRequest {
  ctx: RequestContextSnapshot
  /** Streaming byte/event totals from `request.stream_progress`. */
  streamBytesIn?: number
  streamEventsIn?: number
  streamBlockType?: string
  /** Features applied to this request (e.g. "truncated", "thinking:adaptive"). */
  tags: Array<string>
  /** Was this a `/history/*` route? Suppresses completion line unless it errored. */
  isHistoryAccess: boolean
  /** Final status code from terminal event. */
  statusCode?: number
  /** Per-attempt counter — incremented on each `request.attempt_started`. */
  attemptCount: number
}

export interface ConsoleSinkOptions {
  stdout?: NodeJS.WritableStream
  isTTY?: boolean
  /** Show `[....]` start lines (only in `consola.level >= 5`). Default true. */
  showActive?: boolean
  /**
   * Whether to hijack `consola.setReporters` so log lines coordinate with
   * the footer. Default `true`. **Set `false` in commits 3b-3e** to avoid
   * shadowing the legacy `ConsoleRenderer`'s reporter (which also hijacks
   * consola) and producing a TTY footer-flicker regression during the
   * transition window. Commit 4 flips this back to `true` once
   * `ConsoleRenderer` is removed.
   */
  hijackConsola?: boolean
  /**
   * When `true`, the sink subscribes and tracks state internally but
   * writes nothing to stdout. **Set `true` in commits 3b-3e** because the
   * legacy `ConsoleRenderer` (installed by main.ts:initConsolaReporter)
   * still owns rendering — each lifecycle event would otherwise produce
   * one `[ OK ]` line from each renderer. Commit 4 deletes
   * ConsoleRenderer and flips this back to `false`.
   *
   * The subscription stays alive so the sink-ordering integration test
   * (tests/observability/sink-ordering.unit.test.ts) still pins the
   * History → Telemetry → Ws → Console attach contract.
   */
  silent?: boolean
}

interface ConsolaReporter {
  log(logObj: { args: Array<unknown>; type: string }): void
}

export class ConsoleSink {
  private readonly stdout: NodeJS.WritableStream
  private readonly isTTY: boolean
  private readonly showActive: boolean
  private readonly hijackConsola: boolean
  private readonly silent: boolean
  private readonly active = new Map<string, ActiveRequest>()
  private footerVisible = false
  private footerTimer: ReturnType<typeof setInterval> | null = null
  private readonly originalReporters: Array<unknown>
  private readonly unsubscribe: () => void

  constructor(bus: ObservabilityBus, options?: ConsoleSinkOptions) {
    this.stdout = options?.stdout ?? process.stdout
    this.isTTY = options?.isTTY ?? process.stdout.isTTY
    this.showActive = options?.showActive ?? true
    this.hijackConsola = options?.hijackConsola ?? true
    this.silent = options?.silent ?? false

    if (this.hijackConsola) {
      // Preserve original reporters BEFORE installing ours so destroy() can restore.
      this.originalReporters = [...consola.options.reporters]
      consola.setReporters([this.makeFooterAwareReporter()])
    } else {
      this.originalReporters = []
    }

    this.unsubscribe = bus.subscribe((event) => {
      this.handle(event)
    })
  }

  destroy(): void {
    this.unsubscribe()
    this.stopFooterTimer()
    if (this.footerVisible && this.isTTY) {
      this.stdout.write(CLEAR_LINE)
      this.footerVisible = false
    }
    this.active.clear()
    if (this.hijackConsola && this.originalReporters.length > 0) {
      consola.setReporters(this.originalReporters as Parameters<typeof consola.setReporters>[0])
    }
  }

  // ============================================================================
  // Event dispatch
  // ============================================================================

  private handle(event: ObservabilityEvent): void {
    switch (event.kind) {
      case "request.created": {
        this.onCreated(event.ctx)
        return
      }
      case "request.model_resolved":
      case "request.state_changed": {
        this.upsertCtx(event.ctx)
        return
      }
      case "request.attempt_started": {
        const entry = this.upsertCtx(event.ctx)
        entry.attemptCount = Math.max(entry.attemptCount, event.attempt.attemptIndex + 1)
        return
      }
      case "request.attempt_failed": {
        if (event.willRetry) this.onAttemptFailed(event)
        return
      }
      case "request.stream_progress": {
        const entry = this.upsertCtx(event.ctx)
        if (event.bytesIn !== undefined) entry.streamBytesIn = event.bytesIn
        if (event.eventsIn !== undefined) entry.streamEventsIn = event.eventsIn
        if (event.blockType !== undefined) entry.streamBlockType = event.blockType
        return
      }
      case "request.feature_applied": {
        const entry = this.upsertCtx(event.ctx)
        const tag = renderFeatureTag(event.feature, event.detail)
        if (tag && !entry.tags.includes(tag)) entry.tags.push(tag)
        return
      }
      case "request.completed": {
        this.onTerminal(event.ctx, "completed", { statusCode: 200 })
        return
      }
      case "request.failed": {
        this.onTerminal(event.ctx, "failed", {
          statusCode: event.statusCode,
          error: event.error,
        })
        return
      }
      case "request.aborted": {
        this.onTerminal(event.ctx, "aborted", { error: "client disconnected" })
        return
      }
      // history.* / system.* — currently no console output (reserved).
      //
      // request.context_updated is consumed by HistorySink only — see the
      // event doc in events.ts. ConsoleSink already receives the
      // higher-fidelity signals (state_changed / feature_applied / etc.)
      // and would only get duplicates from context_updated.
      case "history.entry_added":
      case "history.entry_updated":
      case "history.stats_changed":
      case "history.cleared":
      case "history.session_deleted":
      case "system.rate_limit_state":
      case "system.shutdown_phase_changed":
      case "system.shutdown_completed":
      case "request.context_updated": {
        return
      }
      default: {
        // Exhaustiveness check — any new event kind not handled above
        // becomes a compile-time error here.
        assertNever(event)
      }
    }
  }

  // ============================================================================
  // Lifecycle handlers
  // ============================================================================

  private onCreated(ctx: RequestContextSnapshot): void {
    const entry: ActiveRequest = {
      ctx,
      tags: [],
      isHistoryAccess: ctx.path.startsWith("/history"),
      attemptCount: 0,
    }
    this.active.set(ctx.id, entry)
    this.startFooterTimer()

    if (this.showActive && consola.level >= 5) {
      const message = formatLogLine({
        prefix: "[....]",
        time: formatTime(),
        method: ctx.method,
        path: ctx.path,
        model: ctx.resolvedModel,
        isDim: true,
      })
      this.printLog(message)
    }
  }

  private upsertCtx(ctx: RequestContextSnapshot): ActiveRequest {
    let entry = this.active.get(ctx.id)
    if (!entry) {
      // Late-arriving event for a context we missed `created` for (e.g. test
      // harness publishing without a prior `created`). Materialize on demand.
      entry = {
        ctx,
        tags: [],
        isHistoryAccess: ctx.path.startsWith("/history"),
        attemptCount: 0,
      }
      this.active.set(ctx.id, entry)
      this.startFooterTimer()
    } else {
      // Refresh the snapshot — model_resolved / state changes carry updated ctx.
      entry.ctx = ctx
    }
    return entry
  }

  private onAttemptFailed(event: Extract<ObservabilityEvent, { kind: "request.attempt_failed" }>): void {
    const entry = this.upsertCtx(event.ctx)
    const attemptN = event.attempt.attemptIndex + 1
    entry.attemptCount = Math.max(entry.attemptCount, attemptN)

    const metaParts: Array<string> = [`retryable: ${event.nextStrategy ?? event.attempt.strategy ?? "?"}`]
    if (event.waitMs && event.waitMs > 0) metaParts.push(`wait ${formatDuration(event.waitMs)}`)
    if (event.learning) metaParts.push("learning")
    const retryableMeta = `(${metaParts.join(", ")})`

    const elapsed = formatDuration(Date.now() - event.ctx.startTime)
    const errMsg = event.attempt.error?.message
    const extra = errMsg ? `: ${errMsg}` : undefined

    const message = formatLogLine({
      prefix: `[RETRY-${attemptN}]`,
      time: formatTime(),
      method: event.ctx.method,
      path: event.ctx.path,
      model: event.ctx.resolvedModel,
      clientModel: event.ctx.clientModel,
      multiplier: event.ctx.multiplier,
      status: event.attempt.error?.status,
      duration: elapsed,
      requestBodySize: event.ctx.requestBodySize,
      responseBodySize: entry.streamBytesIn,
      extra,
      retryableMeta,
      isRetry: true,
    })
    this.printLog(message)
  }

  private onTerminal(ctx: RequestContextSnapshot, kind: "completed" | "failed" | "aborted", info: { statusCode?: number; error?: string }): void {
    const entry = this.active.get(ctx.id) ?? {
      ctx,
      tags: [],
      isHistoryAccess: ctx.path.startsWith("/history"),
      attemptCount: 0,
    }
    this.active.delete(ctx.id)
    if (this.active.size === 0) this.stopFooterTimer()

    // Update snapshot for accurate clientModel/multiplier rendering.
    entry.ctx = ctx
    entry.statusCode = info.statusCode

    // Skip completed log line for history access (only errors are shown).
    const isError = kind !== "completed" || (info.statusCode !== undefined && info.statusCode >= 400)
    if (entry.isHistoryAccess && !isError) {
      this.renderFooter()
      return
    }

    const status = info.statusCode
    const durationMs = Date.now() - ctx.startTime
    const queueWait = ctx.queueWaitMs > 100 ? formatDuration(ctx.queueWaitMs) : undefined

    const tagStr = !isError && entry.tags.length > 0 ? pc.dim(` (${entry.tags.join(", ")})`) : ""
    const errorStr = isError && info.error ? `: ${info.error}` : ""
    const extra = tagStr + errorStr || undefined

    const message = formatLogLine({
      prefix: isError ? "[FAIL]" : "[ OK ]",
      time: formatTime(),
      method: ctx.method,
      path: ctx.path,
      model: ctx.resolvedModel,
      clientModel: ctx.clientModel,
      multiplier: ctx.multiplier,
      status,
      duration: formatDuration(durationMs),
      queueWait,
      requestBodySize: ctx.requestBodySize,
      responseBodySize: entry.streamBytesIn,
      extra,
      isError,
    } satisfies LogLineParts)
    this.printLog(message)
  }

  // ============================================================================
  // Footer
  // ============================================================================

  private buildFooter(): string {
    const count = this.active.size
    if (count === 0) return ""
    const now = Date.now()

    if (count === 1) {
      const entry = this.active.values().next().value
      if (!entry) return ""
      const elapsed = formatDuration(now - entry.ctx.startTime)
      const model = entry.ctx.resolvedModel ? ` ${entry.ctx.resolvedModel}` : ""
      const streamInfo = formatStreamInfo({
        bytesIn: entry.streamBytesIn,
        eventsIn: entry.streamEventsIn,
        blockType: entry.streamBlockType,
      })
      return pc.dim(`[<-->] ${entry.ctx.method} ${entry.ctx.path}${model} ${elapsed}${streamInfo}`)
    }

    const MAX_SHOWN = 3
    const all = Array.from(this.active.values()).sort((a, b) => a.ctx.startTime - b.ctx.startTime)
    const shown = all.slice(0, MAX_SHOWN)
    const items = shown.map((entry) => {
      const elapsed = formatDuration(now - entry.ctx.startTime)
      const label = entry.ctx.resolvedModel ?? `${entry.ctx.method} ${entry.ctx.path}`
      const streamInfo = formatStreamInfo({
        bytesIn: entry.streamBytesIn,
        eventsIn: entry.streamEventsIn,
        blockType: entry.streamBlockType,
      })
      return `${label} ${elapsed}${streamInfo}`
    })
    const overflow = count - MAX_SHOWN
    if (overflow > 0) items.push(`+${overflow} more`)
    return pc.dim(`[<-->] ${items.join(" | ")}`)
  }

  private renderFooter(): void {
    if (this.silent) return
    if (!this.isTTY) return
    const footer = this.buildFooter()
    if (footer) {
      this.stdout.write(CLEAR_LINE + footer)
      this.footerVisible = true
    } else if (this.footerVisible) {
      this.stdout.write(CLEAR_LINE)
      this.footerVisible = false
    }
  }

  private clearFooterForLog(): void {
    if (this.footerVisible && this.isTTY) {
      this.stdout.write(CLEAR_LINE)
      this.footerVisible = false
    }
  }

  private startFooterTimer(): void {
    if (this.footerTimer || !this.isTTY) return
    this.footerTimer = setInterval(() => {
      if (this.active.size > 0) {
        this.renderFooter()
      } else {
        this.stopFooterTimer()
      }
    }, 100)
    this.footerTimer.unref()
  }

  private stopFooterTimer(): void {
    if (this.footerTimer) {
      clearInterval(this.footerTimer)
      this.footerTimer = null
    }
  }

  // ============================================================================
  // Output coordination (footer ↔ log lines ↔ consola hijack)
  // ============================================================================

  private printLog(message: string): void {
    if (this.silent) return
    this.clearFooterForLog()
    this.stdout.write(message + "\n")
    this.renderFooter()
  }

  /**
   * Build a consola reporter that wraps each log call in `clearFooterForLog
   * → write → renderFooter` so consola output does not collide with the
   * footer redraw. Preserves the existing UX from `console-renderer.ts`.
   */
  private makeFooterAwareReporter(): ConsolaReporter {
    return {
      log: (logObj) => {
        this.clearFooterForLog()
        const message = logObj.args
          .map((arg) => {
            if (typeof arg === "string") return arg
            if (arg instanceof Error) return arg.stack ?? arg.message
            return JSON.stringify(arg)
          })
          .join(" ")
          .trimEnd()
        const prefix = consolaPrefix(logObj.type)
        if (prefix) {
          this.stdout.write(`${prefix} ${message}\n`)
        } else {
          this.stdout.write(`${message}\n`)
        }
        this.renderFooter()
      },
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Render a `FeatureKind` + detail blob into a human-readable tag for the
 * `[ OK ] ... (foo, bar)` suffix.
 */
function renderFeatureTag(feature: string, detail?: Record<string, unknown>): string | undefined {
  switch (feature) {
    case "truncated":
    case "via-chat-completions-fallback":
    case "via-responses":
    case "dropped-params": {
      return feature
    }
    case "thinking":
    case "thinking-wire": {
      const type = detail?.type
      return typeof type === "string" ? `${feature}:${type}` : feature
    }
    case "beta-stripped": {
      const betas = detail?.betas
      if (Array.isArray(betas) && betas.length > 0) {
        return `beta-strip:${betas.join(",")}`
      }
      return "beta-stripped"
    }
    case "transport": {
      const kind = detail?.kind
      if (kind === "upstream-ws") return "ws"
      if (kind === "upstream-ws-fallback") return "ws→http"
      return undefined
    }
    default: {
      return feature
    }
  }
}

function consolaPrefix(type: string): string {
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

// ============================================================================
// Attachment helper (mirrors attachHistorySink / attachTelemetrySink shape)
// ============================================================================

export function attachConsoleSink(bus: ObservabilityBus, options?: ConsoleSinkOptions): () => void {
  const sink = new ConsoleSink(bus, options)
  return () => {
    sink.destroy()
  }
}
