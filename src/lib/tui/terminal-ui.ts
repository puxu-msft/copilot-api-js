import consola from "consola"

import type { DiagnosticLevelThreshold } from "~/lib/diagnostics"
import type {
  //
  ObservabilityBus,
  ObservabilityEvent,
} from "~/lib/observability"

type NonRequestEvent = Exclude<ObservabilityEvent, { kind: `request.${string}` }>

import { isDiagnosticLevelEnabled } from "~/lib/diagnostics"
import { assertNever } from "~/lib/observability"
import { StreamProgressCoalescer } from "~/lib/observability/stream-progress-coalescer"
import { handleShutdownSignal } from "~/lib/shutdown"
import { registerSensitiveOutput } from "~/lib/tui/sensitive-output"

import type { RequestEvent } from "./active-request-store"
import type { UiState } from "./controller"
import type { KeyEvent } from "./input/keys"

import { ActiveRequestStore } from "./active-request-store"
import { AgentOrdinalRegistry } from "./agent-ordinal-registry"
import {
  //
  INITIAL_UI_STATE,
  reconcile,
  reduce,
  withDetailOffset,
} from "./controller"
import { KeyDecoder } from "./input/key-decoder"
import { OutputArbiter } from "./output-arbiter"
import {
  //

  renderRequestEffect,
  renderSyntheticRequestLine,
} from "./render/lifecycle"
import { renderModelCatalogLines } from "./render/model-list"
import { renderSystemLogLines } from "./render/syslog"
import { registerTerminal } from "./terminal-coordinator"
import { TerminalSession } from "./terminal-session"
import { TerminalView } from "./terminal-view"

export interface TerminalUiOptions {
  stdout?: NodeJS.WritableStream
  isTTY?: boolean
  columns?: number | (() => number)
  rows?: number | (() => number)
  showActive?: boolean
  /** Footer repaint cadence; 0 disables the timer for deterministic byte-golden tests. */
  refreshIntervalMs?: number
  /** Presentation stream-progress coalescing cadence; 0 disables coalescing for deterministic tests. */
  progressIntervalMs?: number
  /** Injectable wall clock for deterministic event/render tests. */
  now?: () => number
  diagnosticLevel?: DiagnosticLevelThreshold | (() => DiagnosticLevelThreshold)
  silent?: boolean
  stdin?: NodeJS.ReadStream
  onShutdownSignal?: (signal: string) => void
  registerExitHook?: (fn: () => void) => unknown
}

/** Thin bus/input orchestrator. Projection, controller, session, and output algorithms live in dedicated owners. */
export class TerminalUi {
  private readonly output: OutputArbiter
  private readonly store = new ActiveRequestStore()
  private readonly ordinals = new AgentOrdinalRegistry()
  private readonly showActive: boolean
  private readonly refreshIntervalMs: number
  private readonly now: () => number
  private readonly silent: boolean
  private readonly isTTY: boolean
  private readonly onShutdownSignal: (signal: string) => void
  private readonly diagnosticLevel: DiagnosticLevelThreshold | (() => DiagnosticLevelThreshold)
  private readonly decoder: KeyDecoder
  private readonly session: TerminalSession
  private readonly view: TerminalView
  private readonly unsubscribe: () => void
  private readonly progress: StreamProgressCoalescer
  private readonly coalesceProgress: boolean
  private unregisterCoordinator: () => void = () => {}
  private readonly unregisterSensitiveOutput: () => void
  private uiState: UiState = INITIAL_UI_STATE
  private footerTimer: ReturnType<typeof setInterval> | undefined
  private shuttingDown = false
  private suspendNoticeShown = false

  constructor(bus: ObservabilityBus, options: TerminalUiOptions = {}) {
    const stdout = options.stdout ?? process.stdout
    this.output = new OutputArbiter(stdout)
    this.isTTY = options.isTTY ?? Boolean((stdout as Partial<{ isTTY: boolean }>).isTTY)
    this.showActive = options.showActive ?? true
    this.refreshIntervalMs = options.refreshIntervalMs ?? 100
    this.now = options.now ?? Date.now
    this.silent = options.silent ?? false
    this.onShutdownSignal = options.onShutdownSignal ?? handleShutdownSignal
    this.diagnosticLevel = options.diagnosticLevel ?? "info"
    const getColumns = numericSource(options.columns, () => (stdout as Partial<{ columns: number }>).columns, 80)
    const getRows = numericSource(options.rows, () => (stdout as Partial<{ rows: number }>).rows, 24)

    this.decoder = new KeyDecoder((events) => this.handleKeys(events))
    this.coalesceProgress = (options.progressIntervalMs ?? 75) > 0
    this.progress = new StreamProgressCoalescer({ intervalMs: options.progressIntervalMs ?? 75, deliver: (event) => this.handleRequestNow(event) })
    this.session = new TerminalSession({
      stdin: options.stdin,
      interactive: !this.silent && this.isTTY,
      isTTY: this.isTTY,
      onData: (chunk) => this.handleKeys(this.decoder.feed(chunk)),
      beforeRestore: () => {
        this.decoder.destroy()
        this.view.restoreVisual()
      },
      beforeSuspend: () => this.view.restoreVisual(),
      drainOutput: () => this.output.drain(),
      onResume: () => {
        this.view.resume()
        this.render()
      },
      registerExitHook:
        options.registerExitHook
        ?? ((hook) => {
          process.on("exit", hook)
          return () => process.off("exit", hook)
        }),
    })
    this.view = new TerminalView({ output: this.output, isTTY: this.isTTY, interactive: this.session.interactive, silent: this.silent, getColumns, getRows })

    if (!this.silent) {
      this.unregisterCoordinator = registerTerminal({
        state: () => this.view.terminalState(),
        clearPanel: () => this.view.clearPanelString(),
        redrawPanel: () => this.view.redrawPanelString(this.uiState, this.store.snapshot(), this.now()),
        write: (data) => this.view.writeCoordinatorFrame(data),
      })
    }
    this.output.setOnFault(() => this.unregisterCoordinator())
    this.unregisterSensitiveOutput = registerSensitiveOutput({
      isInteractive: () => this.isTTY && !this.output.faulted,
      write: (text) => this.output.writeSensitiveOnce(text),
    })
    this.unsubscribe = bus.subscribe((event) => this.handle(event), undefined, { name: "terminal-ui" })
  }

  destroy(): void {
    this.unregisterSensitiveOutput()
    this.unregisterCoordinator()
    this.unsubscribe()
    this.stopTimer()
    this.progress.destroy()
    this.session.restoreSyncBestEffort()
    this.view.destroy()
    this.store.clear()
    this.output.destroy()
  }

  private handle(event: ObservabilityEvent): void {
    if (event.kind.startsWith("request.")) {
      this.handleRequest(event as RequestEvent)
      return
    }
    this.handleNonRequest(event as NonRequestEvent)
  }

  private handleNonRequest(event: NonRequestEvent): void {
    switch (event.kind) {
      case "system.model_catalog": {
        const threshold = typeof this.diagnosticLevel === "function" ? this.diagnosticLevel() : this.diagnosticLevel
        if (!isDiagnosticLevelEnabled("info", threshold)) return
        for (const line of renderModelCatalogLines(event)) this.view.printLine(line)
        this.render()
        return
      }
      case "system.diagnostic": {
        const threshold = typeof this.diagnosticLevel === "function" ? this.diagnosticLevel() : this.diagnosticLevel
        if (!isDiagnosticLevelEnabled(event.diagnostic.severity, threshold)) return
        for (const line of renderSystemLogLines(event.diagnostic)) this.view.printLine(line)
        this.render()
        return
      }
      case "system.request_line": {
        this.view.printLine(renderSyntheticRequestLine(event.parts))
        this.render()
        return
      }
      case "system.shutdown_phase_changed": {
        if (event.phase === "draining" && !this.shuttingDown) {
          this.shuttingDown = true
          this.stopTimer()
          this.session.beginShutdownRestore()
        }
        return
      }
      // history.* / system.* — currently no console output (reserved).
      case "history.entry_added":
      case "history.entry_updated":
      case "history.stats_changed":
      case "history.cleared":
      case "history.session_deleted":
      case "system.rate_limit_state":
      case "system.shutdown_completed": {
        return
      }
      case "system.shutdown_failed": {
        this.view.printLine(`[shutdown] failed: ${event.errors.map((error) => error.message).join("; ")}`)
        return
      }
      default: {
        assertNever(event)
      }
    }
  }

  private handleRequest(event: RequestEvent): void {
    if (event.kind === "request.stream_progress") {
      if (this.coalesceProgress) this.progress.push(event)
      else this.handleRequestNow(event)
      return
    }
    if (event.kind === "request.completed" || event.kind === "request.failed" || event.kind === "request.aborted") this.progress.flush(event.ctx.id)
    this.handleRequestNow(event)
  }

  private handleRequestNow(event: RequestEvent): void {
    if (event.kind === "request.created") this.ordinals.ordinalFor(event.ctx.sessionId, event.ctx.agentId)
    const before = this.uiState
    const change = this.store.apply(event)
    this.uiState = reconcile(this.uiState, change.activeIds, change, this.visibleRows())

    if (before.view === "detail" && this.uiState.view !== "detail") this.render()
    const now = this.now()
    for (const effect of change.effects) {
      const line = renderRequestEffect(effect, {
        now,
        showActive: this.showActive,
        verbose: consola.level >= 5,
        ordinalFor: (sessionId, agentId) => this.ordinals.ordinalFor(sessionId, agentId),
      })
      if (line) this.view.printLine(line)
    }
    this.syncTimer()
    if (change.effects.length > 0) this.render()
  }

  private handleKeys(keys: ReadonlyArray<KeyEvent>): void {
    for (const key of keys) {
      if (key.kind === "ctrl-c" || key.kind === "ctrl-d" || key.kind === "quit") {
        this.onShutdownSignal("SIGINT")
        continue
      }
      if (key.kind === "suspend") {
        void this.session.suspend().then((suspended) => {
          if (!suspended && !this.suspendNoticeShown) {
            this.suspendNoticeShown = true
            this.view.printLine("[terminal] suspend is unavailable on this platform")
            this.render()
          }
        })
        continue
      }
      this.uiState = reduce(this.uiState, key, { activeIds: this.store.orderedIds(), visibleRows: this.visibleRows() })
      this.render()
    }
  }

  private render(): void {
    if (this.shuttingDown) return
    const offset = this.view.render(this.uiState, this.store.snapshot(), this.now())
    if (offset !== undefined) this.uiState = withDetailOffset(this.uiState, offset)
  }

  private visibleRows(): number {
    return this.view.visibleRequestRows(this.store.size, this.uiState.showHelp)
  }

  private syncTimer(): void {
    if (this.store.size > 0 && this.isTTY && this.refreshIntervalMs > 0 && !this.footerTimer) {
      this.footerTimer = setInterval(() => this.render(), this.refreshIntervalMs)
      this.footerTimer.unref()
    } else if (this.store.size === 0) this.stopTimer()
  }

  private stopTimer(): void {
    if (!this.footerTimer) return
    clearInterval(this.footerTimer)
    this.footerTimer = undefined
  }
}

function numericSource(value: number | (() => number) | undefined, live: () => number | undefined, fallback: number): () => number {
  return () => {
    const raw = typeof value === "function" ? value() : (value ?? live())
    return raw !== undefined && raw > 0 ? raw : fallback
  }
}

export function attachTerminalUi(bus: ObservabilityBus, options?: TerminalUiOptions): () => void {
  const sink = new TerminalUi(bus, options)
  return () => sink.destroy()
}

export { formatThinkingTag } from "./render/lifecycle"
