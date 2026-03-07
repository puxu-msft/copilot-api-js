import { state } from "~/lib/state"

/**
 * Create an AbortSignal for fetch timeout if configured.
 * Controls the time from request start to receiving response headers.
 * Returns undefined if fetchTimeout is 0 (disabled).
 */
export function createFetchSignal(): AbortSignal | undefined {
  return state.fetchTimeout > 0 ? AbortSignal.timeout(state.fetchTimeout * 1000) : undefined
}
