// TUI module exports

export { tuiLogger } from "./middleware"
export { requestTracker } from "./tracker"
export type {
  RequestStatus,
  RequestUpdate,
  TrackedRequest,
  TuiOptions,
  TuiRenderer,
} from "./types"

import type { TuiOptions } from "./types"

import { ConsoleRenderer } from "./console-renderer"
import { requestTracker } from "./tracker"

// Singleton renderer instance (created once, used for both logging and request tracking)
let renderer: ConsoleRenderer | null = null

/**
 * Initialize the consola reporter for unified log formatting.
 * This should be called as early as possible to capture all logs.
 * Does NOT set up request tracking - call initRequestTracker() for that.
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
export function initRequestTracker(options?: TuiOptions): void {
  if (renderer) {
    requestTracker.setRenderer(renderer)
  }

  if (
    options?.historySize !== undefined
    || options?.completedDisplayMs !== undefined
  ) {
    requestTracker.setOptions({
      historySize: options.historySize,
      completedDisplayMs: options.completedDisplayMs,
    })
  }
}
