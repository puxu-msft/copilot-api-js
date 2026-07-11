/**
 * Terminal UI sink — renders observability events as a single-line terminal log
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
 * - `system.shutdown_phase_changed` — on the `draining` transition (scheme A,
 *   RFC §7) restore the terminal from raw mode and stop owning the bottom
 *   region, reverting the drain period to a plain log stream.
 * - `system.rate_limit_state` — non-line side effect (no console output
 *   currently; reserved for future UX).
 *
 * Replaces `lib/tui/console-renderer.ts` (deleted in commit 4). TerminalUi
 * is the authoritative stdout renderer for request lifecycle lines + footer.
 */

import consola from "consola"
import pc from "picocolors"

import type { HistoryEntryData } from "~/lib/context/types"
import type {
  //
  AttemptSnapshot,
  FeatureKind,
  ObservabilityBus,
  ObservabilityEvent,
  RequestContextSnapshot,
} from "~/lib/observability"
import type { LogLineParts } from "~/lib/observability/projections/log-line"

import { assertNever } from "~/lib/observability"
import {
  //
  formatDuration,
  formatDurationField,
  formatTime,
  resolveDurationColorMs,
} from "~/lib/observability/projections/format"
import { formatLogLine } from "~/lib/observability/projections/log-line"
import { handleShutdownSignal } from "~/lib/shutdown"

import type { UiState } from "./controller"

import {
  //
  INITIAL_UI_STATE,
  reduce,
} from "./controller"
import { parseKeys } from "./input/keys"
import { buildActiveFooter } from "./render/footer"
import {
  //
  buildCollapsedLines,
  buildDetailLines,
  buildPanelLines,
  panelContentRows,
} from "./render/panel"
import {
  //
  Region,
  RESERVED_LOG_ROWS,
} from "./render/region"
import { renderSystemLogLine } from "./render/syslog"

// ANSI escape code for "clear to end of line, return to column 0"
const CLEAR_LINE = "\x1b[2K\r"
// Hide the cursor for the interactive panel's lifetime (restored on teardown).
const HIDE_CURSOR = "\x1b[?25l"

/** Mutable per-request display state — replaces `TuiLogEntry`. */
interface ActiveRequest {
  ctx: RequestContextSnapshot
  /** Streaming byte/event totals from `request.stream_progress`. */
  streamBytesIn?: number
  streamEventsIn?: number
  streamBlockType?: string
  /** Features applied to this request (e.g. "truncated", "beta-strip:..."). */
  tags: Array<string>
  /**
   * Thinking as a terminal dimension (NOT an accumulated tag): `requested` is
   * set once (fixed), `effective` is overwritten per attempt (last wins). Rendered
   * once at completion via {@link formatThinkingTag}, so a multi-attempt request
   * yields exactly one thinking tag instead of a contradictory pile-up.
   */
  thinking?: { requested?: string; effective: string }
  /** Was this a `/history/*` route? Suppresses completion line unless it errored. */
  isHistoryAccess: boolean
  /** Final status code from terminal event. */
  statusCode?: number
  /** Per-attempt counter — incremented on each `request.attempt_started`. */
  attemptCount: number
  /**
   * Full per-attempt diagnostics accumulated from `request.attempt_started` /
   * `attempt_failed` (richest-data-flow, evaluator §5): the interactive detail
   * view surfaces the complete strategy / transport / error of every attempt,
   * never a collapsed `attemptCount`. Empty for single-attempt requests until
   * the first attempt event arrives.
   */
  attempts: Array<AttemptSnapshot>
}

export interface TerminalUiOptions {
  stdout?: NodeJS.WritableStream
  isTTY?: boolean
  /**
   * Terminal width source for footer truncation. A number pins a fixed width
   * (tests); a function is read live on each render (production reads
   * `process.stdout.columns` so SIGWINCH resizes are picked up ≤100ms later by
   * the footer timer, no resize listener needed). Default: read the stdout's
   * live `columns`, falling back to 80.
   */
  columns?: number | (() => number)
  /** Show `[....]` start lines (only in `consola.level >= 5`). Default true. */
  showActive?: boolean
  /**
   * When `true`, the sink subscribes and tracks state internally but writes
   * nothing to stdout. Used by tests that pin the sink attach order without
   * asserting rendered bytes.
   */
  silent?: boolean
  /**
   * Raw-mode input source for the interactive panel (P1). **Load-bearing gate
   * (evaluator §3, test-isolation):** the interactive path is enabled *only*
   * when this is explicitly provided (and `isTTY` + `setRawMode` hold). Existing
   * golden / attach-order / usage tests inject no `stdin`, so they stay on the
   * P0 footer path and never touch the real `process.stdin`. Production
   * (`start.ts`) passes `process.stdin` explicitly. Default: unset → non-interactive.
   */
  stdin?: NodeJS.ReadStream
  /**
   * Terminal height source for the DECSTBM {@link Region} (interactive only). A
   * number pins it (tests); a function is read live per render (production reads
   * `process.stdout.rows` so SIGWINCH resizes re-anchor within ≤100ms). Default:
   * read the stdout's live `rows`, falling back to 24.
   */
  rows?: number | (() => number)
  /**
   * Ctrl-C handler (interactive only): raw mode swallows the kernel's SIGINT, so
   * the parsed `ctrl-c` key is forwarded here. Default: {@link handleShutdownSignal}.
   */
  onShutdownSignal?: (signal: string) => void
  /**
   * Register a terminal-restore hook that runs on process exit — the crash /
   * exit safety net (PoC-4) that guarantees the terminal is restored even when
   * `destroy()` is never called. Default: `process.on("exit", fn)`.
   */
  registerExitHook?: (fn: () => void) => void
}

export class TerminalUi {
  private readonly stdout: NodeJS.WritableStream
  private readonly isTTY: boolean
  private readonly columns: number | (() => number)
  private readonly showActive: boolean
  private readonly silent: boolean
  private readonly active = new Map<string, ActiveRequest>()
  private footerVisible = false
  private footerTimer: ReturnType<typeof setInterval> | null = null
  private readonly unsubscribe: () => void

  // ── Interactive panel (P1) — all inert unless `this.interactive` ───────────
  /**
   * `true` when raw-mode interaction is enabled: `!silent && isTTY &&
   * setRawMode-capable stdin was *explicitly injected* (evaluator §3). A false
   * gate keeps the whole P0 footer path untouched — no raw mode, no `process.stdin`
   * access, no DECSTBM. Fixed at construction, never toggled (two mode paths,
   * one per instance — no in-instance seam).
   */
  private readonly interactive: boolean
  /** Injected raw-mode stdin (only held when interactive). */
  private readonly stdin?: NodeJS.ReadStream
  /** Terminal height source for the Region (interactive only). */
  private readonly rows: number | (() => number)
  /** Ctrl-C forwarder (raw mode swallows the kernel SIGINT). */
  private readonly onShutdownSignal: (signal: string) => void
  /** The DECSTBM sticky-region renderer — sole owner of the bottom panel. */
  private readonly region?: Region
  /** The `stdin` "data" listener, retained so `restoreTerminal` can detach it. */
  private readonly onData?: (chunk: Buffer) => void
  /** Pure UI state machine cursor (view / selection / scroll / help). */
  private uiState: UiState = INITIAL_UI_STATE
  /** Idempotency latch for {@link restoreTerminal} (exit-hook + destroy race). */
  private restored = false
  /**
   * Set once the shutdown drain phase begins (scheme A, RFC §7). After this,
   * {@link renderRegion} no-ops so the drain period reverts to a plain log
   * stream — the terminal is already restored to cooked mode, so a subsequent
   * Ctrl-C becomes a real SIGINT that `shutdown.ts` escalates to the next phase.
   */
  private shuttingDown = false
  /**
   * Reentrancy guard for {@link renderRegion} (mirrors `republish.ts` H1): a
   * synchronous render must never re-enter itself (e.g. a write that logs). All
   * renders are synchronous, so a set flag means "drop this nested call".
   */
  private rendering = false

  constructor(bus: ObservabilityBus, options?: TerminalUiOptions) {
    this.stdout = options?.stdout ?? process.stdout
    this.isTTY = options?.isTTY ?? process.stdout.isTTY
    this.columns = options?.columns ?? (() => (this.stdout as Partial<{ columns: number }>).columns ?? 80)
    this.showActive = options?.showActive ?? true
    this.silent = options?.silent ?? false
    this.rows = options?.rows ?? (() => (this.stdout as Partial<{ rows: number }>).rows ?? 24)
    this.onShutdownSignal = options?.onShutdownSignal ?? handleShutdownSignal

    // Interactive gate: enabled *only* on explicit stdin injection so existing
    // non-injecting tests (golden / attach-order / usage) never touch the real
    // `process.stdin` (test-isolation, evaluator §3). Production wires
    // `process.stdin` explicitly at the attach site (start.ts).
    const stdin = options?.stdin
    this.interactive = !this.silent && this.isTTY && stdin !== undefined && typeof stdin.setRawMode === "function"

    if (this.interactive && stdin) {
      this.stdin = stdin
      this.region = new Region({
        stdout: this.stdout,
        getColumns: () => this.getColumns(),
        getRows: () => this.getRows(),
      })
      const onData = (chunk: Buffer): void => this.onInput(chunk)
      this.onData = onData
      stdin.setRawMode(true)
      stdin.resume()
      stdin.on("data", onData)
      this.stdout.write(HIDE_CURSOR)
      // Crash / exit safety net (PoC-4): restore even if destroy() never runs.
      // `options` is narrowed non-null here (interactive implies stdin was given).
      ;(options.registerExitHook ?? ((fn: () => void) => process.on("exit", fn)))(() => this.restoreTerminal())
    }

    this.unsubscribe = bus.subscribe((event) => {
      this.handle(event)
    })
  }

  /** Current terminal width (read live per render). Non-positive → 80 fallback. */
  private getColumns(): number {
    const raw = typeof this.columns === "function" ? this.columns() : this.columns
    return raw > 0 ? raw : 80
  }

  /** Current terminal height (read live per render). Non-positive → 24 fallback. */
  private getRows(): number {
    const raw = typeof this.rows === "function" ? this.rows() : this.rows
    return raw > 0 ? raw : 24
  }

  /** Max panel rows the Region can show (height minus the reserved log rows). */
  private panelRows(): number {
    return Math.max(1, this.getRows() - RESERVED_LOG_ROWS)
  }

  destroy(): void {
    this.unsubscribe()
    this.stopFooterTimer()
    if (this.interactive) {
      this.restoreTerminal()
    } else if (this.footerVisible && this.isTTY) {
      this.stdout.write(CLEAR_LINE)
      this.footerVisible = false
    }
    this.active.clear()
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
        this.recordAttempt(entry, event.attempt)
        return
      }
      case "request.attempt_failed": {
        // Accumulate the richer (error-carrying) snapshot for the detail view
        // regardless of `willRetry`; the `[RETRY-n]` log line is retry-only.
        const entry = this.upsertCtx(event.ctx)
        this.recordAttempt(entry, event.attempt)
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
        // `thinking` is a terminal dimension, not an accumulated tag: set
        // `requested` once (fixed), overwrite `effective` per attempt. Rendered
        // once at completion — avoids the cross-attempt contradictory pile-up.
        if (event.feature === "thinking") {
          const d = (event.detail ?? {}) as { requested?: unknown; effective?: unknown }
          if (typeof d.effective === "string") {
            const requested = typeof d.requested === "string" ? d.requested : entry.thinking?.requested
            entry.thinking = requested !== undefined ? { requested, effective: d.effective } : { effective: d.effective }
          }
          return
        }
        const tag = renderFeatureTag(event.feature, event.detail)
        if (tag && !entry.tags.includes(tag)) entry.tags.push(tag)
        return
      }
      case "request.completed": {
        this.onTerminal(event.ctx, "completed", { statusCode: 200 }, event.entry)
        return
      }
      case "request.failed": {
        this.onTerminal(
          event.ctx,
          "failed",
          {
            statusCode: event.statusCode,
            error: event.error,
          },
          event.entry,
        )
        return
      }
      case "request.aborted": {
        this.onTerminal(event.ctx, "aborted", { error: "client disconnected" }, event.entry)
        return
      }
      // Non-HTTP consola logs republished onto the bus (republish.ts). Rendered
      // through the same footer-coordinated printLog path the old hijack
      // reporter used, so stdout bytes are unchanged.
      case "system.log": {
        this.onSystemLog(event)
        return
      }
      // Scheme A (RFC §7): the moment the server begins draining, restore the
      // terminal from raw mode and stop owning the bottom region. The drain
      // period reverts to a plain log stream; a further Ctrl-C now lands on a
      // cooked terminal → real SIGINT → shutdown.ts escalates the phase. Only
      // the first `draining` transition acts; later phase bumps are inert
      // (restoreTerminal is idempotent, and the flag is already set).
      case "system.shutdown_phase_changed": {
        if (event.phase === "draining" && !this.shuttingDown) {
          this.shuttingDown = true
          this.restoreTerminal()
        }
        return
      }
      // history.* / system.* — currently no console output (reserved).
      //
      // request.context_updated is consumed by HistorySink only — see the
      // event doc in events.ts. TerminalUi already receives the
      // higher-fidelity signals (state_changed / feature_applied / etc.)
      // and would only get duplicates from context_updated.
      case "history.entry_added":
      case "history.entry_updated":
      case "history.stats_changed":
      case "history.cleared":
      case "history.session_deleted":
      case "system.rate_limit_state":
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
      attempts: [],
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
        attempts: [],
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

    const elapsedMs = Date.now() - event.ctx.startTime
    const lastMs = event.attempt.durationMs
    const retries = event.attempt.attemptIndex + 1 // 1-based：这是第 N 次重试
    const durationField = formatDurationField({ lastMs, totalMs: elapsedMs, retries })
    const colorMs = resolveDurationColorMs({ lastMs, totalMs: elapsedMs, retries })
    const errMsg = event.attempt.error?.message
    const extra = errMsg ? `: ${errMsg}` : undefined

    const message = formatLogLine({
      prefix: `[RETRY]`,
      time: formatTime(),
      method: event.ctx.method,
      path: event.ctx.path,
      model: event.ctx.resolvedModel,
      clientModel: event.ctx.clientModel,
      multiplier: event.ctx.multiplier,
      status: event.attempt.error?.status,
      duration: durationField,
      durationMs: colorMs,
      requestBodySize: event.ctx.requestBodySize,
      responseBodySize: entry.streamBytesIn,
      extra,
      retryableMeta,
      isRetry: true,
    })
    this.printLog(message)
  }

  private onTerminal(
    ctx: RequestContextSnapshot,
    kind: "completed" | "failed" | "aborted",
    info: { statusCode?: number; error?: string },
    historyEntry?: HistoryEntryData,
  ): void {
    const entry = this.active.get(ctx.id) ?? {
      ctx,
      tags: [],
      isHistoryAccess: ctx.path.startsWith("/history"),
      attemptCount: 0,
      attempts: [],
    }
    this.active.delete(ctx.id)
    if (this.active.size === 0) this.stopFooterTimer()

    // Update snapshot for accurate clientModel/multiplier rendering.
    entry.ctx = ctx
    entry.statusCode = info.statusCode

    // Skip completed log line for history access (only errors are shown).
    const isError = kind !== "completed" || (info.statusCode !== undefined && info.statusCode >= 400)
    if (entry.isHistoryAccess && !isError) {
      this.render()
      return
    }

    const status = info.statusCode
    const durationMs = Date.now() - ctx.startTime
    const queueWait = ctx.queueWaitMs > 100 ? formatDuration(ctx.queueWaitMs) : undefined

    // 重试时长字段：有重试（attempts 多于 1 条）展开为 `last/total(N)`，无重试保持单值。
    // 零 attempt 终态（early failure）时 attempts 为 undefined，retries 兜底 0、单值不崩。
    const attempts = historyEntry?.attempts
    const retries = (attempts?.length ?? 1) - 1
    const lastMs = attempts?.at(-1)?.durationMs
    const durationField = formatDurationField({ lastMs, totalMs: durationMs, retries })
    const durationColorMs = resolveDurationColorMs({ lastMs, totalMs: durationMs, retries })

    // Thinking is a terminal field rendered once here (prepended), then the
    // accumulated feature tags.
    const allTags = entry.thinking ? [formatThinkingTag(entry.thinking), ...entry.tags] : entry.tags
    const tagStr = !isError && allTags.length > 0 ? pc.dim(` (${allTags.join(", ")})`) : ""
    const errorStr = isError && info.error ? `: ${info.error}` : ""
    const extra = tagStr + errorStr || undefined

    // Token/cache columns come from the terminal event's history entry (final
    // attempt's upstream usage — the same direct optional-chain access used by
    // context/request.ts). Undefined usage (no attempts / failed early) omits
    // the columns; the log-line formatter is null-tolerant.
    const usage = historyEntry?.attempts?.at(-1)?.upstreamResponse?.usage

    const message = formatLogLine({
      prefix: isError ? "[FAIL]" : "[ OK ]",
      time: formatTime(),
      method: ctx.method,
      path: ctx.path,
      model: ctx.resolvedModel,
      clientModel: ctx.clientModel,
      multiplier: ctx.multiplier,
      status,
      duration: durationField,
      durationMs: durationColorMs,
      queueWait,
      requestBodySize: ctx.requestBodySize,
      responseBodySize: entry.streamBytesIn,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      cacheReadInputTokens: usage?.cache_read_input_tokens,
      cacheCreationInputTokens: usage?.cache_creation_input_tokens,
      extra,
      reqId: isError ? ctx.id : undefined,
      isError,
    } satisfies LogLineParts)
    this.printLog(message)
  }

  // ============================================================================
  // Footer
  // ============================================================================

  /**
   * Build the active-request footer. Delegates to the pure
   * {@link buildActiveFooter} — this sink only supplies the live inputs:
   * the active-request snapshots, the current wall clock, and the sanitized
   * terminal width ({@link getColumns} applies the non-positive → 80 fallback,
   * so the builder receives a clean number).
   */
  private buildFooter(): string {
    return buildActiveFooter({ active: [...this.active.values()], now: Date.now(), columns: this.getColumns() })
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

  /**
   * Clear the footer before writing a log line. The single-line `CLEAR_LINE`
   * (`\x1b[2K\r`) only erases the current physical line — this is correct
   * *because* the footer builder's finalize step in `~/lib/tui/render/footer`
   * guarantees the footer is always ≤ 1 physical line. If footer truncation is
   * ever relaxed, this clear (and {@link renderFooter}'s overwrite) would leave
   * residue on wrapped lines.
   */
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
        this.render()
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
    if (this.interactive) {
      // The Region owns the reserved bottom area; the last `Region.render` parked
      // the cursor (DECRC) inside the DECSTBM scroll region, so this log line
      // lands in the scrolling area *above* the panel. No `CLEAR_LINE` here — under
      // DECSTBM it would wrongly wipe the reserved panel row. Redraw after.
      this.stdout.write(message + "\n")
      this.renderRegion()
      return
    }
    this.clearFooterForLog()
    this.stdout.write(message + "\n")
    this.renderFooter()
  }

  /**
   * Render a republished consola log (`system.log` event) through the same
   * footer-coordinated path the old hijack reporter used. `message` is already
   * args-joined by republish.ts; {@link renderSystemLogLine} produces the full
   * `[INFO] HH:MM:SS message` line from the log's own timestamp.
   */
  private onSystemLog(event: Extract<ObservabilityEvent, { kind: "system.log" }>): void {
    this.printLog(renderSystemLogLine(event))
  }

  // ============================================================================
  // Interactive panel (P1) — raw-mode input, unified Region render, restore
  // ============================================================================

  /**
   * Upsert an {@link AttemptSnapshot} into the entry's `attempts[]`, keyed by
   * `attemptIndex`. `attempt_started` seeds the row; the later `attempt_failed`
   * for the same index replaces it with the error-carrying snapshot (richest
   * form wins) — so the detail view shows one row per attempt with its outcome.
   */
  private recordAttempt(entry: ActiveRequest, snapshot: AttemptSnapshot): void {
    const existing = entry.attempts.findIndex((a) => a.attemptIndex === snapshot.attemptIndex)
    if (existing !== -1) {
      entry.attempts[existing] = snapshot
    } else {
      entry.attempts.push(snapshot)
    }
  }

  /**
   * The single render dispatcher (interactive → Region, else → P0 footer). All
   * redraw triggers (bus events via the footer timer, terminal-event settle,
   * keyboard input) funnel through here so a TerminalUi instance never mixes the
   * two rendering models within its lifetime (evaluator BLOCK-1).
   */
  private render(): void {
    if (this.interactive) {
      this.renderRegion()
    } else {
      this.renderFooter()
    }
  }

  /**
   * Decode a raw-mode stdin chunk and drive the UI. `ctrl-c` is forwarded to the
   * injected shutdown handler (raw mode swallowed the kernel SIGINT); every other
   * key advances the pure {@link reduce} state machine and re-renders. P1 is
   * read-only — the reducer no-ops on `x`/`c`/`char`.
   */
  private onInput(chunk: Buffer): void {
    for (const key of parseKeys(chunk)) {
      if (key.kind === "ctrl-c") {
        this.onShutdownSignal("SIGINT")
        continue
      }
      this.uiState = reduce(this.uiState, key, {
        activeCount: this.active.size,
        visibleRows: this.visibleRequestRows(),
      })
      this.renderRegion()
    }
  }

  /**
   * Request rows the panel shows at once — the controller's `visibleRows` for
   * scroll math. Uses the SAME {@link panelContentRows} helper `buildPanelLines`
   * uses, from the same inputs, so the selection window stays exactly aligned
   * (a mismatch would let the cursor scroll out of the visible window).
   */
  private visibleRequestRows(): number {
    return panelContentRows(this.panelRows(), this.active.size, this.uiState.showHelp)
  }

  /**
   * The interactive render entry point (replaces `renderFooter` when
   * interactive). Composes the lines for the current view and hands them to the
   * Region — collapsed is N=1 (the same footer content plus a discoverability
   * hint), panel/detail are the multi-line builders. When there is nothing to
   * show (no active requests while collapsed) the Region is torn down so the
   * scroll region is reset and the terminal returns to a plain log stream.
   * Synchronous + reentrancy-guarded (mirrors `republish.ts`).
   */
  private renderRegion(): void {
    if (this.silent || !this.region || this.shuttingDown) return
    if (this.rendering) return
    this.rendering = true
    try {
      const lines = this.buildViewLines()
      if (lines.length === 0) {
        this.region.clear()
      } else {
        this.region.render(lines)
      }
    } finally {
      this.rendering = false
    }
  }

  /** Compose the lines for the current {@link UiState.view} (pure builders). */
  private buildViewLines(): Array<string> {
    const now = Date.now()
    const columns = this.getColumns()
    const views = [...this.active.values()]

    switch (this.uiState.view) {
      case "collapsed": {
        // N=1 degenerate Region: nothing to show when idle → empty (Region.clear).
        if (views.length === 0) return []
        return buildCollapsedLines({ active: views, now, columns, showHelp: this.uiState.showHelp })
      }
      case "panel": {
        if (views.length === 0) return []
        return buildPanelLines({
          active: views,
          now,
          columns,
          selectedIndex: this.uiState.selectedIndex,
          scrollOffset: this.uiState.scrollOffset,
          rows: this.panelRows(),
          showHelp: this.uiState.showHelp,
        })
      }
      case "detail": {
        // `.at()` returns `ActiveRequest | undefined` — honest about the stale
        // selection (the request completed while its detail was open), which the
        // guard below handles by degrading to the collapsed footer.
        const entry = views.at(this.uiState.selectedIndex)
        // Selection fell out of range — degrade to the collapsed footer rather
        // than render nothing.
        if (!entry) {
          if (views.length === 0) return []
          return buildCollapsedLines({ active: views, now, columns, showHelp: this.uiState.showHelp })
        }
        return buildDetailLines({ entry, now, columns })
      }
      default: {
        return []
      }
    }
  }

  /**
   * Restore the terminal from raw mode (idempotent — exit-hook, `destroy()`,
   * and the shutdown-drain phase all call it). Detaches the stdin listener,
   * pauses stdin, leaves raw mode, and tears down the Region (DECSTBM reset
   * `\x1b[r` + cursor shown). No-op when non-interactive or already restored.
   */
  private restoreTerminal(): void {
    if (!this.interactive || this.restored) return
    this.restored = true
    if (this.onData) this.stdin?.removeListener("data", this.onData)
    this.stdin?.pause()
    this.stdin?.setRawMode(false)
    this.region?.clear()
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Render the thinking terminal field into a single console tag. `effective` is
 * the authoritative "what actually ran"; a differing `requested` is shown as
 * `requested→effective` (matching the `ws→http` convention) to surface coercion.
 */
export function formatThinkingTag(thinking: { requested?: string; effective: string }): string {
  return thinking.requested !== undefined && thinking.requested !== thinking.effective ?
      `thinking:${thinking.requested}→${thinking.effective}`
    : `thinking:${thinking.effective}`
}

/**
 * Render a `FeatureKind` + detail blob into a human-readable tag for the
 * `[ OK ] ... (foo, bar)` suffix. (`thinking` is handled separately as a
 * terminal field — see {@link formatThinkingTag} — and is excluded from the
 * parameter type via the caller's narrowing at the `feature === "thinking"`
 * early return.)
 *
 * The switch is **exhaustive** over `Exclude<FeatureKind, "thinking">`: a new
 * `FeatureKind` fails to compile at `assertNever` rather than silently leaking
 * its bare name as a tag.
 */
function renderFeatureTag(feature: Exclude<FeatureKind, "thinking">, detail?: Record<string, unknown>): string | undefined {
  switch (feature) {
    // Stream keepalive lifecycle is operational noise — not surfaced as a TUI tag.
    case "stream-immediate-keepalive":
    case "stream-upstream-resolved": {
      return undefined
    }
    case "truncated":
    case "via-chat-completions-fallback":
    case "via-responses":
    case "dropped-params": {
      return feature
    }
    // Recovery / repair outcomes — surfaced as bare-name tags (detail
    // enrichment deferred to backlog; keeping the pre-exhaustiveness behavior).
    case "tool-call-recovered":
    case "refusal-recovered":
    case "refusal-errored":
    case "tool-input-decode-failed":
    case "protect-streaming-retry":
    case "context-edits-applied":
    case "tool-input-repaired":
    case "tool-input-unrepairable": {
      return feature
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
      // Exhaustiveness check — a new FeatureKind becomes a compile-time error.
      return assertNever(feature)
    }
  }
}

// ============================================================================
// Attachment helper (mirrors attachHistorySink / attachTelemetrySink shape)
// ============================================================================

export function attachTerminalUi(bus: ObservabilityBus, options?: TerminalUiOptions): () => void {
  const sink = new TerminalUi(bus, options)
  return () => {
    sink.destroy()
  }
}
