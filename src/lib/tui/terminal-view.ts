import type { ActiveRequest } from "./active-request-store"
import type { UiState } from "./controller"
import type { OutputArbiter } from "./output-arbiter"
import type { TerminalRegionState } from "./terminal-coordinator"

import {
  //
  buildDetailDocument,
  layoutDetailViewport,
} from "./render/detail"
import { buildActiveFooter } from "./render/footer"
import {
  //
  buildCollapsedLines,
  buildPanelLines,
  panelContentRows,
} from "./render/panel"
import {
  //
  Region,
  RESERVED_LOG_ROWS,
} from "./render/region"

const CLEAR_LINE = "\x1b[2K\r"
const ALT_ON = "\x1b[?1049h"
const ALT_OFF = "\x1b[?1049l"
const RESET_DETAIL = "\x1b[r\x1b[?6l"
const CLEAR_HOME = "\x1b[H\x1b[2J"
const REPLAY_CAP = 200

export interface TerminalViewOptions {
  output: OutputArbiter
  isTTY: boolean
  interactive: boolean
  silent: boolean
  getColumns: () => number
  getRows: () => number
}

/** Stateful terminal renderer; all bytes are delegated to OutputArbiter. */
export class TerminalView {
  private readonly output: OutputArbiter
  private readonly isTTY: boolean
  private readonly interactive: boolean
  private readonly silent: boolean
  private readonly getColumns: () => number
  private readonly getRows: () => number
  private readonly region?: Region
  private footerVisible = false
  private detailActive = false
  private detailRows?: number
  private rendering = false
  private readonly replayQueue: Array<string> = []

  constructor(options: TerminalViewOptions) {
    this.output = options.output
    this.isTTY = options.isTTY
    this.interactive = options.interactive
    this.silent = options.silent
    this.getColumns = options.getColumns
    this.getRows = options.getRows
    if (this.interactive) this.region = new Region({ output: this.output, getColumns: this.getColumns, getRows: this.getRows })
  }

  visibleRequestRows(activeCount: number, showHelp: boolean): number {
    return panelContentRows(Math.max(1, this.getRows() - RESERVED_LOG_ROWS), activeCount, showHelp)
  }

  render(state: UiState, active: ReadonlyArray<ActiveRequest>, now: number): number | undefined {
    if (this.silent) return undefined
    if (!this.interactive) {
      this.renderFooter(active, now)
      return undefined
    }
    if (state.view === "detail") return this.renderDetail(state, active, now)
    if (this.detailActive) this.exitDetail()
    this.renderRegion(state, active, now)
    return undefined
  }

  printLine(line: string): void {
    if (this.silent) return
    if (this.detailActive) {
      this.replayQueue.push(line)
      if (this.replayQueue.length > REPLAY_CAP) this.replayQueue.shift()
      return
    }
    if (!this.interactive) this.clearFooter()
    this.output.writeLine(`${line}\n`)
  }

  restoreVisual(): void {
    if (this.detailActive) {
      this.output.writeLine(ALT_OFF)
      this.detailActive = false
      this.detailRows = undefined
    }
    this.region?.clear()
    if (this.footerVisible && this.isTTY) {
      this.output.writeFrame(CLEAR_LINE)
      this.footerVisible = false
    }
  }

  resume(): void {
    this.region?.forceReestablish()
    this.detailActive = false
    this.detailRows = undefined
  }

  destroy(): void {
    this.restoreVisual()
    this.replayQueue.length = 0
  }

  terminalState(): TerminalRegionState {
    if (this.detailActive) return "alt"
    if (this.interactive) return this.region?.isEstablished() ? "region" : "none"
    return this.footerVisible ? "inline" : "none"
  }

  clearPanelString(): string {
    return this.interactive ? (this.region?.clearPanelString() ?? "") : CLEAR_LINE
  }

  redrawPanelString(state: UiState, active: ReadonlyArray<ActiveRequest>, now: number): string {
    if (this.interactive) return this.region?.redrawString(this.buildRegionLines(state, active, now)) ?? ""
    return this.buildFooter(active, now)
  }

  writeCoordinatorFrame(data: string): void {
    this.output.writeLine(data)
  }

  private renderFooter(active: ReadonlyArray<ActiveRequest>, now: number): void {
    if (!this.isTTY) return
    const footer = this.buildFooter(active, now)
    if (footer) {
      this.output.writeFrame(CLEAR_LINE + footer)
      this.footerVisible = true
    } else this.clearFooter()
  }

  private buildFooter(active: ReadonlyArray<ActiveRequest>, now: number): string {
    return buildActiveFooter({ active, now, columns: this.getColumns() })
  }

  private clearFooter(): void {
    if (!this.footerVisible || !this.isTTY) return
    this.output.writeFrame(CLEAR_LINE)
    this.footerVisible = false
  }

  private renderRegion(state: UiState, active: ReadonlyArray<ActiveRequest>, now: number): void {
    if (!this.region || this.rendering) return
    this.rendering = true
    try {
      const lines = this.buildRegionLines(state, active, now)
      if (lines.length === 0) this.region.clear()
      else this.region.render(lines)
    } finally {
      this.rendering = false
    }
  }

  private buildRegionLines(state: UiState, active: ReadonlyArray<ActiveRequest>, now: number): Array<string> {
    if (state.view === "collapsed") return active.length === 0 ? [] : buildCollapsedLines({ active, now, columns: this.getColumns(), showHelp: state.showHelp })
    if (state.view !== "panel" || active.length === 0) return []
    const ids = active.map((entry) => entry.ctx.id)
    return buildPanelLines({
      active,
      now,
      columns: this.getColumns(),
      selectedIndex: state.selectedRequestId === undefined ? -1 : ids.indexOf(state.selectedRequestId),
      scrollOffset: state.scrollOffset,
      rows: Math.max(1, this.getRows() - RESERVED_LOG_ROWS),
      showHelp: state.showHelp,
    })
  }

  private renderDetail(state: UiState, active: ReadonlyArray<ActiveRequest>, now: number): number | undefined {
    const entry = active.find((candidate) => candidate.ctx.id === state.detailRequestId)
    if (!entry) return undefined
    const rows = this.getRows()
    const resized = this.detailActive && this.detailRows !== rows
    if (!this.detailActive) {
      this.detailActive = true
      this.output.writeFrame(ALT_ON + RESET_DETAIL + CLEAR_HOME)
    } else if (resized) this.output.writeFrame(RESET_DETAIL)
    this.detailRows = rows
    const viewport = layoutDetailViewport(buildDetailDocument(entry, now), { rows, columns: this.getColumns(), offset: state.detailScrollOffset })
    this.output.writeFrame(CLEAR_HOME + viewport.lines.join("\r\n"))
    return viewport.offset
  }

  private exitDetail(): void {
    this.detailActive = false
    this.detailRows = undefined
    this.output.writeLine(ALT_OFF)
    this.region?.forceReestablish()
    for (const line of this.replayQueue.splice(0)) this.output.writeLine(`${line}\n`)
  }
}
