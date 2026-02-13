/** TUI module exports */

export { tuiMiddleware } from "./middleware"
export { tuiLogger } from "./tracker"
export type { RequestStatus, RequestUpdate, TuiLogEntry, TuiOptions, TuiRenderer } from "./types"

import type { TuiOptions } from "./types"

import { ConsoleRenderer } from "./console-renderer"
import { tuiLogger } from "./tracker"

/** Singleton renderer instance (created once, used for both logging and request tracking) */
let renderer: ConsoleRenderer | null = null

/**
 * Initialize the consola reporter for unified log formatting.
 * This should be called as early as possible to capture all logs.
 * Does NOT set up request tracking - call initTuiLogger() for that.
 *
 * @param forceEnable - Force enable even if not TTY (useful for consistent log format)
 */
export function initConsolaReporter(forceEnable = true): void {
  if (!renderer && (forceEnable || process.stdout.isTTY)) {
    renderer = new ConsoleRenderer()
  }
}

/**
 * Initialize request tracking with the TUI renderer.
 * Should be called after initConsolaReporter() and before handling requests.
 */
export function initTuiLogger(options?: TuiOptions): void {
  if (renderer) {
    tuiLogger.setRenderer(renderer)
  }

  if (options?.historySize !== undefined || options?.completedDisplayMs !== undefined) {
    tuiLogger.setOptions({
      historySize: options.historySize,
      completedDisplayMs: options.completedDisplayMs,
    })
  }
}
