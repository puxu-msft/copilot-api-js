/**
 * Token refresh retry strategy.
 *
 * Handles 401/403 errors by refreshing the Copilot token and retrying.
 * When the Copilot token expires between scheduled refreshes, this strategy
 * triggers an immediate refresh so the request can be retried transparently.
 */

import consola from "consola"

import type { ApiError } from "~/lib/error"

import { peekTokenRuntime } from "~/lib/token"

import type {
  //
  RetryAction,
  RetryContext,
  RetryStrategy,
} from "../retry-types"

/**
 * Refresh the Copilot token via the installed runtime.
 * Returns true on success, false if no runtime is installed or refresh failed.
 */
async function refreshCopilotToken(): Promise<boolean> {
  const runtime = peekTokenRuntime()
  if (!runtime) return false
  return runtime.refreshCopilotToken()
}

/**
 * Create a token refresh retry strategy.
 *
 * On `auth_expired` errors (401/403), refreshes the Copilot token via
 * `CopilotTokenManager.refresh()`, then retries with the same payload.
 * Only retries once per pipeline execution to avoid infinite refresh loops.
 */
export function createTokenRefreshStrategy<TPayload>(): RetryStrategy<TPayload> {
  // Track whether we've already attempted a refresh in this pipeline execution.
  // A second 401 after refresh means the problem isn't a stale token.
  let hasRefreshed = false

  return {
    name: "token-refresh",

    canHandle(error: ApiError): boolean {
      return error.type === "auth_expired" && !hasRefreshed
    },

    async handle(error: ApiError, currentPayload: TPayload, context: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      consola.info(`[TokenRefresh] Attempt ${context.attempt + 1}/${context.maxRetries + 1}: ` + `Got ${error.status}, refreshing Copilot token...`)

      const success = await refreshCopilotToken()
      hasRefreshed = true

      if (!success) {
        consola.error("[TokenRefresh] Token refresh failed, aborting request")
        return { action: "abort", error }
      }

      consola.info("[TokenRefresh] Token refreshed, retrying request")

      // Retry with the same payload — the new token is in global state,
      // which the adapter reads when constructing the Authorization header
      return {
        action: "retry",
        payload: currentPayload,
        meta: { tokenRefreshed: true },
      }
    },
  }
}
