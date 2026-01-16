// TUI module exports

export { ConsoleRenderer } from "./console-renderer"
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

/**
 * Initialize the TUI system
 */
export function initTui(options?: TuiOptions): void {
  const enabled = options?.enabled ?? process.stdout.isTTY

  if (enabled) {
    const renderer = new ConsoleRenderer()
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
