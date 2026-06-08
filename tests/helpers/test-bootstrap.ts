import {
  //
  afterEach,
  beforeAll,
  beforeEach,
} from "bun:test"

import { resetAdaptiveRateLimiter } from "~/lib/adaptive-rate-limiter"
import { registerContextConsumers } from "~/lib/context/consumers"
import {
  //
  initRequestContextManager,
  resetRequestContextManagerForTests,
} from "~/lib/context/manager"
import {
  //
  clearHistory,
  initHistory,
} from "~/lib/history"
import { _resetShutdownState } from "~/lib/shutdown"
import {
  //
  type StateSnapshot,
  restoreStateForTests,
  snapshotStateForTests,
} from "~/lib/state"
import { tuiLogger } from "~/lib/tui"

let initialized = false

export function bootstrapTestRuntime() {
  if (initialized) return

  initHistory(true, 100)
  const manager = initRequestContextManager()
  registerContextConsumers(manager)

  initialized = true
}

export function resetTestRuntime() {
  _resetShutdownState()
  clearHistory()
  tuiLogger.clear()
  resetAdaptiveRateLimiter()
  registerContextConsumers(resetRequestContextManagerForTests())
}

/**
 * Register the standard runtime lifecycle for an HTTP-style test describe:
 *   - `bootstrapTestRuntime()` once before all tests (idempotent)
 *   - snapshot global state before each test
 *   - restore state + `resetTestRuntime()` after each test
 *
 * Collapses the boilerplate repeated across the `.http.test.ts` files:
 *   let snapshot: StateSnapshot
 *   beforeAll(() => bootstrapTestRuntime())
 *   beforeEach(() => { snapshot = snapshotStateForTests() })
 *   afterEach(() => { restoreStateForTests(snapshot); resetTestRuntime() })
 *
 * The snapshot is captured in a `beforeEach` registered by this call, so it
 * runs before any file-specific `beforeEach` (setStateForTests / setModels)
 * registered afterwards — keeping the snapshot pristine. Place file-specific
 * per-test setup in a separate `beforeEach` after calling this.
 *
 * Mirrors `autoRestoreFetch()` / `autoRestoreState()`. State restore and
 * runtime reset are orthogonal (state object vs history/context/rate-limiter
 * singletons), so this composes cleanly with the fetch helper.
 */
export function autoTestRuntime(): void {
  let snapshot: StateSnapshot
  beforeAll(() => {
    bootstrapTestRuntime()
  })
  beforeEach(() => {
    snapshot = snapshotStateForTests()
  })
  afterEach(() => {
    restoreStateForTests(snapshot)
    resetTestRuntime()
  })
}
