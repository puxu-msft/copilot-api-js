/**
 * Terminal UI sink — renders observability events as a single-line terminal log
 * stream with an active-request footer.
 *
 * Subscribes to:
 * - `request.created` / `request.model_resolved` / `request.state_changed`
 *   — track active requests; render `[....]` start line in debug mode.
 * - `request.feature_applied` / `request.stream_progress` — mutate active
 *   entry's display state (streaming bytes, feature tags).
 * - `request.attempt_failed { willRetry: true }` — render `[RETRY]` line
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
import type { TerminalRegionState } from "./terminal-coordinator"

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
import { registerTerminal } from "./terminal-coordinator"

// ANSI escape code for "clear to end of line, return to column 0"
const CLEAR_LINE = "\x1b[2K\r"
// Hide the cursor for the interactive panel's lifetime (restored on teardown).
const HIDE_CURSOR = "\x1b[?25l"
/**
 * Bound on {@link TerminalUi.replayQueue} (P1.3): log lines that arrive while
 * `detailActive` are queued instead of dropped, but the queue must not grow
 * unbounded for a long-lived detail visit — the oldest entries are shifted
 * out past this cap. Durability of a dropped replay entry depends on WHICH
 * kind of line it was (I2, whole-branch review) — `replayQueue` mixes two
 * durability backends via {@link printLog}'s two callers: `system.log` lines
 * (from {@link onSystemLog}) are independently persisted by `FileSink`
 * (`~/lib/observability/sinks/file.ts`), but request-lifecycle lines
 * (`[....]`/`[RETRY]`/`[ OK ]`/`[FAIL]`, from {@link onCreated} /
 * {@link onAttemptFailed} / {@link onTerminal}) are NOT — `FileSink`'s own
 * header comment states it "deliberately does NOT write request lifecycle
 * lines" (they live in history.db instead, in a structured form, not as this
 * rendered text). So a dropped `system.log` entry is only missing from this
 * process's scrollback (still in the log file); a dropped lifecycle entry's
 * rendered text is gone for good — though the underlying data survives in
 * history.db, just not as this exact console line.
 */
const REPLAY_CAP = 200

/** Mutable per-request display state — replaces `TuiLogEntry`. */
interface ActiveRequest {
  ctx: RequestContextSnapshot
  /** Streaming byte/event totals from `request.stream_progress`. */
  streamBytesIn?: number
  streamEventsIn?: number
  streamBlockType?: string
  /** Features applied to this request (e.g. "beta-stripped", "via-responses"). */
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
  /**
   * Latch for the detail alternate-screen entry (P1.1 C1): `true` once
   * `\x1b[?1049h` has been written for the current detail visit, so a
   * re-render (e.g. a bus event arriving while detail is open) repaints
   * content without re-entering the alternate screen or re-resetting the
   * scroll margins. Cleared by `exitDetail` (P1.2).
   */
  private detailActive = false
  /**
   * Stable identity of the request currently shown in the alt-screen detail
   * view (root-cause fix, whole-branch review I1 re-review): captured once at
   * detail entry ({@link renderDetail}'s first-entry branch) and used for
   * EVERY subsequent lookup — `this.active.get(this.detailReqId)` — instead of
   * re-resolving `[...active.values()].at(selectedIndex)` against a `Map`
   * that's being concurrently mutated by `onTerminal`'s `active.delete()`.
   * Index-based re-lookup is unsound the moment any active entry ahead of the
   * viewed one terminates: deleting it left-shifts `Map` iteration order, so
   * `.at(selectedIndex)` silently resolves to whichever OTHER request shifted
   * into that now-stale slot — a silent switch, not a degrade (this is what
   * bit the prior fix: it only handled the viewed request's OWN termination,
   * not a sibling's). Id-based lookup is immune: `Map.get` doesn't care where
   * an entry sits, only whether it still exists. Cleared by {@link exitDetail}
   * and {@link restoreTerminal} alongside {@link detailActive}/{@link detailRows}.
   */
  private detailReqId?: string
  /**
   * Terminal row count as of the last {@link renderDetail} write, so a
   * `getRows()` change while detail is already open (a live SIGWINCH resize,
   * M7) is distinguishable from an ordinary content repaint — see
   * {@link renderDetail}'s resize branch. `undefined` before the first detail
   * entry (which always resets margins regardless via the `detailActive`
   * one-shot branch, so no comparison is needed there).
   */
  private detailRows?: number
  /**
   * Log lines queued by {@link printLog}'s `detailActive` guard while the
   * alt-screen detail view is open (P1.3) — replayed into the scrollback by
   * {@link flushReplayQueue} on {@link exitDetail}. Bounded at
   * {@link REPLAY_CAP}; best-effort only — see {@link REPLAY_CAP}'s doc for
   * which lines that drop is (`FileSink`-durable) or isn't (lifecycle lines,
   * only in history.db in structured form) durable elsewhere.
   */
  private readonly replayQueue: Array<string> = []
  /**
   * Unregisters this instance from `terminal-coordinator` (P2.2) — called at
   * {@link destroy}. A no-op when `silent` (never registered — see the
   * constructor comment) so `destroy()` can call it unconditionally.
   */
  private readonly unregisterCoordinator: () => void

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

    // Register with the terminal-coordinator singleton (P2.2) so republish.ts's
    // reentrant fallback and FileSink's write-failure fallback can route an
    // emergency line through this instance's bottom-of-screen state instead of
    // a bare `process.stderr.write` — see `emergencyWriteState`/`emergencyClearPanel`/
    // `emergencyRedrawPanel`/`emergencyWriteLine` below. Skipped when `silent`
    // (a silent sink draws nothing, so there is no bottom-of-screen state to
    // coordinate — the coordinator's "unregistered" stderr fallback is correct
    // for it, same as before this instance ever registers).
    this.unregisterCoordinator =
      this.silent ?
        () => {}
      : registerTerminal({
          state: () => this.emergencyWriteState(),
          clearPanel: () => this.emergencyClearPanel(),
          redrawPanel: () => this.emergencyRedrawPanel(),
          write: (s) => this.emergencyWriteLine(s),
        })

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
    this.unregisterCoordinator()
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
        // regardless of `willRetry`; the `[RETRY]` log line is retry-only.
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
      // Synthetic request-style line (count_tokens et al.): render exactly like a
      // real request-completion line (formatLogLine → footer-coordinated printLog),
      // but WITHOUT a RequestContext — these routes are out-of-observability and
      // this event never touches history/telemetry.
      case "system.request_line": {
        this.printLog(formatLogLine(event.parts))
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
    const retries = attemptN // 1-based：这是第 N 次重试（复用上方 attemptN，同为 attemptIndex + 1）
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
    // Detail-view continuity (whole-branch review I1, root-cause re-fix):
    // `this.detailReqId` is the stable identity {@link renderDetail} latches
    // at detail entry and resolves by on every repaint — reading it here
    // (rather than re-deriving `[...active.values()].at(selectedIndex)`, which
    // is exactly the index-based resolution this fix replaces) tells apart
    // "the viewed request itself just terminated" from "some OTHER request
    // terminated while a different one is being viewed", with no dependency
    // on `active`'s iteration order or the timing of the `active.delete()`
    // below.
    const viewingId = this.detailActive ? this.detailReqId : undefined

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
      // I1: the entry whose detail is open just terminated — degrade instead
      // of leaving the alt screen on stale content (see the fuller comment at
      // the end of this method, the mirror of this branch).
      if (viewingId === ctx.id) {
        this.exitDetail()
      } else {
        this.render()
      }
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

    // I1 (whole-branch review, root-cause re-fix): `printLog`'s `detailActive`
    // guard queues this line into `replayQueue` and returns WITHOUT
    // re-rendering — by design, detail must never be polluted by a log line.
    // That means a terminated request whose detail is the one currently on
    // screen never reaches `renderDetail` on its own from THIS event — nothing
    // here calls `render()`/`renderDetail()`. Two things now make that safe
    // either way:
    //   1. `renderDetail` resolves the viewed entry via `this.detailReqId`
    //      (not `selectedIndex`), so even if this call were skipped, the next
    //      driver of `render()` (the 100ms footer timer, if any OTHER active
    //      request keeps it alive; a keypress; a bus event) would find
    //      `active.get(detailReqId) === undefined` and degrade correctly — no
    //      silent switch to a sibling that shifted into the old index slot.
    //   2. This explicit call makes that degrade IMMEDIATE (no waiting for the
    //      next timer tick, and it still fires even if `active.size` just hit
    //      0 and the timer was stopped above) when the VIEWED entry itself is
    //      the one that just terminated.
    if (viewingId === ctx.id) this.exitDetail()
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
      if (this.detailActive) {
        // The alt-screen detail view has no scrolling log area of its own — the
        // Region (and its DECSTBM scroll region) is torn down while detail is
        // open. Writing here or calling `renderRegion` would corrupt the
        // full-screen detail paint (renderRegion's `region.clear()` branch
        // writes RESET_SCROLL_REGION + ERASE_TO_END + SHOW_CURSOR straight into
        // the alt screen). Queue it instead — `exitDetail` drains
        // `replayQueue` into the scrollback via `flushReplayQueue` once the
        // alt screen is gone (P1.3).
        this.replayQueue.push(message)
        if (this.replayQueue.length > REPLAY_CAP) this.replayQueue.shift() // bounded — see REPLAY_CAP's doc for per-line-kind durability
        return
      }
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
   * The render dispatcher for bus-driven redraws (footer timer, terminal-event
   * settle, keyboard input via {@link onInput}) — interactive → Region or
   * detail alt-screen, else → P0 footer: non-interactive always uses the P0
   * inline footer; interactive always uses `Region.render` for
   * collapsed/panel, or the alt-screen detail path — never both within one
   * visit. {@link printLog} (log-line redraws from `system.log` /
   * request-lifecycle events) does NOT funnel through here — it has its own
   * `detailActive` guard and calls {@link renderRegion} directly when not in
   * detail, so a log line never dispatches into {@link renderDetail}.
   */
  private render(): void {
    if (!this.interactive) {
      this.renderFooter()
    } else if (this.uiState.view === "detail") {
      this.renderDetail()
    } else {
      this.renderRegion()
    }
  }

  /**
   * Decode a raw-mode stdin chunk and drive the UI. `ctrl-c` is forwarded to the
   * injected shutdown handler (raw mode swallowed the kernel SIGINT); every other
   * key advances the pure {@link reduce} state machine and re-renders via the
   * single {@link render} dispatcher (evaluator BLOCK-1/C2) — never calls
   * `renderRegion` directly, so a transition into `detail` reaches
   * {@link renderDetail} (the alt-screen path) instead of the Region, which
   * would clear the just-entered detail screen. P1 is read-only — the reducer
   * no-ops on `x`/`c`/`char`.
   */
  private onInput(chunk: Buffer): void {
    for (const key of parseKeys(chunk)) {
      if (key.kind === "ctrl-c") {
        this.onShutdownSignal("SIGINT")
        continue
      }
      const prevView = this.uiState.view
      this.uiState = reduce(this.uiState, key, {
        activeCount: this.active.size,
        visibleRows: this.visibleRequestRows(),
      })
      // Leaving detail (detail→panel via `esc`) must exit the alternate screen
      // (P1.2 fleshes out the full restore — reconstitute region + replay).
      if (prevView === "detail" && this.uiState.view !== "detail") {
        this.exitDetail()
      } else {
        this.render()
      }
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
   * The interactive render entry point for `collapsed`/`panel` (replaces
   * `renderFooter` when interactive; `detail` is dispatched to
   * {@link renderDetail} instead — see {@link render}). Composes the lines for
   * the current view and hands them to the Region — collapsed is N=1 (the same
   * footer content plus a discoverability hint), panel is the multi-line
   * selection table. When there is nothing to show (no active requests while
   * collapsed) the Region is torn down so the scroll region is reset and the
   * terminal returns to a plain log stream. Synchronous + reentrancy-guarded
   * (mirrors `republish.ts`).
   */
  private renderRegion(): void {
    if (this.silent || !this.region || this.shuttingDown) return
    if (this.rendering) return
    this.rendering = true
    try {
      const lines = this.paddedViewLines()
      if (lines.length === 0) {
        this.region.clear()
      } else {
        this.region.render(lines)
      }
    } finally {
      this.rendering = false
    }
  }

  /**
   * {@link buildViewLines}, padded to the constant interactive panel height
   * (spec INV-2) — the exact lines {@link renderRegion} hands to `Region.render`.
   * Pulled out so `emergencyRedrawPanel` (P2.2, `terminal-coordinator`) can
   * redraw the SAME content an ordinary re-render would, without duplicating
   * the padding rule.
   */
  private paddedViewLines(): Array<string> {
    // Default collapsed = N=1 (single footer line, no padding): the idle/default
    // view occupies just one row (user 2026-07-11). `buildPanelLines` already
    // returns its own constant height. The scroll region's geometry now DOES
    // change across a collapsed↔panel toggle — blank gaps on shrink are
    // tolerable, but the grow direction must never EAT a log line, which
    // `Region.render`'s scroll-before-grow guarantees (verified via the
    // pty+pyte self-test `exp/tui-rawmode/pty_grid_test.py`).
    return this.buildViewLines()
  }

  /**
   * Compose the lines for the current `collapsed`/`panel` {@link UiState.view}
   * (pure builders). `detail` is handled entirely by {@link renderDetail} (the
   * alt-screen path) and never reaches this builder — `render()` dispatches
   * `detail` there before either `renderRegion` or this method run.
   */
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
      default: {
        return []
      }
    }
  }

  /**
   * The detail alt-screen render path (P1.1, resize handling added P1.5/M7).
   * Entered once per detail visit (latched by {@link detailActive}): writes
   * the alternate-screen sequence, then resets the DECSTBM scroll margins left
   * over from the panel/collapsed Region — order is load-bearing (C1):
   * entering the alt screen first, then resetting margins, then defensively
   * turning off DECOM (origin mode), then clearing, ensures the full-screen
   * detail paint isn't clipped to the panel's old 1–3-row scroll region. Every
   * call (first entry, a bus-triggered repaint, or a post-resize repaint while
   * already in detail) repaints the full-screen detail content.
   *
   * **M7 (resize while detail is open)**: unlike the panel/collapsed path
   * (whose geometry churn is `Region`'s `geometryChanged` re-anchor), detail
   * has no `Region` of its own — the alt screen is a single full-width,
   * full-height canvas with no sticky panel to re-anchor. So a terminal resize
   * while detail is open is handled entirely here, comparing the live
   * `getRows()` against {@link detailRows} (the row count as of the last
   * write): a change re-issues the margin-reset choreography (`\x1b[r` +
   * DECOM off) before repainting, exactly mirroring the one-shot entry
   * sequence, so any stale DECSTBM margins from a mid-resize terminal quirk
   * are cleared. This is deliberately **not** routed through `Region.render`'s
   * `geometryChanged` branch (that class owns the panel/collapsed sticky
   * region only — see plan constraint "不走 panel 的 geometryChanged 重锚").
   */
  private renderDetail(): void {
    if (this.silent || !this.region || this.shuttingDown) return
    // Root-cause fix (whole-branch review I1 re-review): on the FIRST call for
    // this detail visit, latch the viewed request's stable id from the
    // then-current `selectedIndex` — this is the only point where
    // index-based resolution is safe (nothing has been deleted from `active`
    // between the `enter` keypress and this paint). Every subsequent call
    // (bus-triggered repaint, resize, footer-timer tick) resolves by that
    // latched id instead of re-deriving from `selectedIndex`, so a sibling
    // entry's deletion (which left-shifts `Map` iteration order) can never
    // cause this method to silently paint whichever OTHER request shifted
    // into the stale index slot.
    this.detailReqId ??= [...this.active.values()].at(this.uiState.selectedIndex)?.ctx.id
    const entry = this.detailReqId === undefined ? undefined : this.active.get(this.detailReqId)
    if (!entry) {
      // The viewed request is gone (terminated, or selection fell out of
      // range before a first paint) — degrade back to the panel/collapsed
      // Region rather than render a stale or empty alternate screen.
      this.exitDetail()
      return
    }
    const rows = this.getRows()
    const resized = this.detailActive && this.detailRows !== undefined && this.detailRows !== rows
    if (!this.detailActive) {
      this.detailActive = true
      // C1 (load-bearing order): enter alt screen → reset DECSTBM margins →
      // DECOM off (defensive) → clear + home cursor.
      this.stdout.write("\x1b[?1049h" + "\x1b[r" + "\x1b[?6l" + "\x1b[H\x1b[2J")
    } else if (resized) {
      // M7: a live resize while already in detail — re-run the margin-reset
      // half of the entry choreography (no alt-screen re-entry needed, we're
      // already there) before the full-screen repaint below.
      this.stdout.write("\x1b[r" + "\x1b[?6l")
    }
    this.detailRows = rows
    // `ActiveRequest` is structurally a `DetailView` (tags/thinking/attempts are
    // all optional and `ActiveRequest` carries them all) — passed directly,
    // matching the prior `buildViewLines` detail branch's usage; no conversion
    // function is needed.
    const now = Date.now()
    const columns = this.getColumns()
    const lines = buildDetailLines({ entry, now, columns })
    this.stdout.write("\x1b[H\x1b[2J" + lines.join("\r\n"))
  }

  /**
   * Leave the detail alternate screen (P1.2). Order is load-bearing, mirroring
   * `renderDetail`'s C1 entry choreography in reverse:
   *
   * 1. `\x1b[?1049l` drops the alternate screen buffer, returning to the
   *    primary screen — whatever DECSTBM margins were live in either buffer
   *    (the alt screen's full-width reset from entry, or the primary screen's
   *    pre-detail panel margins) are now stale/irrelevant.
   * 2. `region.forceReestablish()` marks the Region's tracked geometry
   *    unknown, so the very next `render()` retakes the "first establish"
   *    branch (HIDE_CURSOR + a fresh DECSTBM) instead of the unchanged-
   *    geometry idempotent reassert — the alt-screen round-trip means the
   *    terminal's real scroll-region state no longer matches what `Region`
   *    last recorded, even though the logical panel height hasn't changed.
   * 3. `flushReplayQueue()` drains log lines queued by `printLog`'s
   *    `detailActive` guard while detail was open, writing them straight to
   *    the (now primary-screen) stdout so they land in the scrollback above
   *    the panel — same synchronous `onInput` turn as the rest of this
   *    method (M8), so no interleaving with a subsequent `renderRegion`.
   * 4. `renderRegion()` repaints the (now current) `panel`/`collapsed` view
   *    into the freshly re-established region.
   *
   * Root-cause fix (whole-branch review I1 re-review): also resets
   * `uiState.view` to `"panel"` here — NOT just via the reducer's `escape`
   * transition. `onInput`'s `escape` path already runs `reduce()` first (which
   * sets `view: "panel"`) before calling this method, so the reset below is a
   * no-op there; but the two OTHER call sites — `renderDetail`'s own
   * out-of-range degrade, and `onTerminal`'s "viewed request terminated"
   * branch — invoke `exitDetail()` directly, bypassing the reducer entirely.
   * Without this reset, `uiState.view` stayed `"detail"` after either of those
   * degrades: `detailActive` was correctly cleared, but the very next
   * `render()` (the next 100ms footer-timer tick) reads `view === "detail"`
   * and calls `renderDetail()` again — which unconditionally re-enters the alt
   * screen (`\x1b[?1049h`) and repaints, because entry is looked up fresh
   * against a `detailReqId` that has just been cleared below, immediately
   * treated as "no id yet" and re-latched from the CURRENT (post-mutation)
   * `selectedIndex` — a spurious bounce back into detail on stale/shifted
   * content. Setting `view: "panel"` here makes the event-triggered and
   * keyboard-triggered exits converge on the same terminal state, so the next
   * `render()` dispatches to `renderRegion()` like an ordinary `esc`.
   */
  private exitDetail(): void {
    if (!this.detailActive) return
    this.detailActive = false
    this.detailRows = undefined
    this.detailReqId = undefined
    this.uiState = { ...this.uiState, view: "panel" }
    this.stdout.write("\x1b[?1049l")
    this.region?.forceReestablish()
    this.flushReplayQueue()
    this.renderRegion()
  }

  /**
   * Drain log lines queued while `detailActive` blocked `printLog` from
   * touching the Region (P1.3). Writes each queued line straight to stdout —
   * mirroring `printLog`'s non-detail branch's `this.stdout.write(message +
   * "\n")` — so it lands in the scrollback above the panel; the caller
   * (`exitDetail`) repaints the panel via `renderRegion()` right after.
   * `.splice(0)` drains and empties `replayQueue` in one step, so a re-entrant
   * `printLog` call during the write (there is none today, but the guard
   * costs nothing) can't see stale queued entries replayed twice.
   */
  private flushReplayQueue(): void {
    for (const message of this.replayQueue.splice(0)) this.stdout.write(message + "\n")
  }

  /**
   * Restore the terminal from raw mode (idempotent — exit-hook, `destroy()`,
   * and the shutdown-drain phase all call it). Detaches the stdin listener,
   * pauses stdin, leaves raw mode, and tears down the Region (DECSTBM reset
   * `\x1b[r` + cursor shown). No-op when non-interactive or already restored.
   *
   * C2 (alt-screen-aware): a crash, exit-hook, or shutdown-drain can fire
   * while a detail view is still on the alternate screen (`detailActive`) —
   * unlike `exitDetail()`'s normal `escape`-driven path, none of those events
   * runs the controller's `detail → panel` transition first. Left unhandled,
   * the process would exit with the terminal stuck in the alt buffer. So
   * `\x1b[?1049l` is written *before* `region.clear()`'s DECSTBM reset +
   * cursor show, dropping back to the primary screen first — mirroring
   * `exitDetail`'s ordering, but without its `forceReestablish` / replay /
   * repaint (there is no more panel to repaint once the terminal is being
   * torn down for good).
   */
  private restoreTerminal(): void {
    if (!this.interactive || this.restored) return
    this.restored = true
    if (this.detailActive) {
      this.stdout.write("\x1b[?1049l")
      this.detailActive = false
      this.detailRows = undefined
      this.detailReqId = undefined
    }
    if (this.onData) this.stdin?.removeListener("data", this.onData)
    this.stdin?.pause()
    this.stdin?.setRawMode(false)
    this.region?.clear()
  }

  // ============================================================================
  // terminal-coordinator hooks (P2.2) — the `TerminalHooks` this instance
  // supplies to `registerTerminal` at construction, so `emergencyWrite` (an
  // out-of-band write from `republish.ts`'s reentrant fallback or `FileSink`'s
  // write-failure fallback) can land without corrupting whatever this instance
  // is currently drawing at the bottom of the screen. `state`/`clearPanel`/
  // `redrawPanel` are pure query/string-producing methods — no writes, no
  // mutation — matching the `TerminalHooks` contract; `write` is the one
  // side-effecting hook.
  // ============================================================================

  /**
   * Current bottom-of-screen render state for `emergencyWrite`'s three-way
   * branch (spec §4 INV-3): `"alt"` when the detail alternate screen is open
   * (`detailActive`); `"region"` when this instance is interactive AND its
   * `Region` has an established DECSTBM scroll region; `"inline"` when this
   * instance is non-interactive AND its P0 footer is currently drawn
   * (`footerVisible`); `"none"` otherwise (interactive-but-idle-collapsed with
   * no established region, non-interactive-with-no-footer, or `silent`/non-TTY —
   * covered defensively even though `silent` instances never register).
   */
  private emergencyWriteState(): TerminalRegionState {
    if (this.detailActive) return "alt"
    if (this.interactive) return this.region?.isEstablished() ? "region" : "none"
    return this.footerVisible ? "inline" : "none"
  }

  /**
   * `clearPanel` hook: escape sequence(s) that blank whatever is currently
   * drawn at the bottom of the screen, for BOTH the `"region"` state (delegates
   * to `Region.clearPanelString()`) and the `"inline"` P0 footer state (the
   * same single-physical-line `CLEAR_LINE` `clearFooterForLog`/`renderFooter`
   * already use — the footer builder guarantees ≤ 1 physical line). Only
   * called by `emergencyWrite` when its own `state()` query returned `"region"`
   * or `"inline"`, so this never needs to handle `"alt"`/`"none"` — those states
   * write-through with no clear/redraw (see `terminal-coordinator.ts`).
   */
  private emergencyClearPanel(): string {
    if (this.interactive) return this.region?.clearPanelString() ?? ""
    return CLEAR_LINE
  }

  /**
   * `redrawPanel` hook: the counterpart to {@link emergencyClearPanel} — repaint
   * whatever the coordinator just cleared, using the SAME padded view lines
   * (`"region"`, via {@link paddedViewLines}) or footer text (`"inline"`, via
   * {@link buildFooter}) an ordinary re-render would produce, so an emergency
   * line never leaves the bottom of the screen looking different from a normal
   * frame.
   */
  private emergencyRedrawPanel(): string {
    if (this.interactive) return this.region?.redrawString(this.paddedViewLines()) ?? ""
    return this.buildFooter()
  }

  /**
   * `write` hook: the coordinator's single side-effecting sink. Deliberately
   * `this.stdout.write` directly — NOT routed through `renderRegion`/`printLog`
   * — so it is never subject to the {@link rendering} reentrancy guard (spec I4:
   * an emergency write, e.g. a reentrant consola call or a `FileSink` disk-full
   * error, must never be silently swallowed by a guard meant only to stop a
   * render from recursing into itself).
   */
  private emergencyWriteLine(s: string): void {
    this.stdout.write(s)
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
    case "tool-input-unrepairable":
    case "translated-content-filter": {
      return feature
    }
    case "beta-stripped": {
      const betas = detail?.betas
      if (Array.isArray(betas) && betas.length > 0) {
        return `beta-strip:${betas.join(",")}`
      }
      return "beta-stripped"
    }
    case "cache-control-stripped": {
      const fields = detail?.fields
      if (Array.isArray(fields) && fields.length > 0) {
        return `cc-strip:${fields.join(",")}`
      }
      return "cache-control-stripped"
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
