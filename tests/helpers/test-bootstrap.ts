import { resetAdaptiveRateLimiter } from "~/lib/adaptive-rate-limiter"
import { registerContextConsumers } from "~/lib/context/consumers"
import { initRequestContextManager, resetRequestContextManagerForTests } from "~/lib/context/manager"
import { clearHistory, initHistory } from "~/lib/history"
import { _resetShutdownState } from "~/lib/shutdown"
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
