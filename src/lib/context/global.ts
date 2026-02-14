/**
 * GlobalContext — Application-level shared state
 *
 * Holds state shared across all requests, initialized at app startup.
 * Replaces scattered global variables (rateLimiterInstance, state, models).
 */

import type { AdaptiveRateLimiter } from "~/lib/adaptive-rate-limiter"
import type { ModelsResponse } from "~/lib/models/client"
import type { State } from "~/lib/state"

export interface GlobalContext {
  /** Adaptive rate limiter (cross-request mode/queue/backoff/recovery state) */
  rateLimiter: AdaptiveRateLimiter | null
  /** Available models list */
  models: ModelsResponse | undefined
  /** Current state (tokens, config, etc.) */
  state: State
}

export function createGlobalContext(opts: { rateLimiter: AdaptiveRateLimiter | null; state: State }): GlobalContext {
  return {
    rateLimiter: opts.rateLimiter,
    models: undefined,
    state: opts.state,
  }
}
