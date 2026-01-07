// TUI module exports

export { ConsoleRenderer } from "./console-renderer"
export { FullscreenRenderer } from "./fullscreen-renderer"
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
import { FullscreenRenderer } from "./fullscreen-renderer"
import { requestTracker } from "./tracker"

export type TuiMode = "console" | "fullscreen"

/**
 * Initialize the TUI system
 * @param options.mode - "console" for simple log output (default), "fullscreen" for interactive TUI
 */
export function initTui(options?: TuiOptions & { mode?: TuiMode }): void {
  const enabled = options?.enabled ?? process.stdout.isTTY
  const mode = options?.mode ?? "console"

  if (enabled) {
    if (mode === "fullscreen") {
      const renderer = new FullscreenRenderer({
        maxHistory: options?.historySize ?? 100,
      })
      requestTracker.setRenderer(renderer)
      renderer.start()
    } else {
      const renderer = new ConsoleRenderer()
      requestTracker.setRenderer(renderer)
    }
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
