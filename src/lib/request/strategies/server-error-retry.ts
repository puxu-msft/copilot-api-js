/**
 * Server error (5xx) retry strategy.
 *
 * Upstream gateways (GHC) intermittently return 5xx — most commonly 502 Bad
 * Gateway / 504 Gateway Timeout — on large or slow requests. These are usually
 * transient: a brief wait + replay of the same payload often succeeds. Mirrors
 * {@link createNetworkRetryStrategy} but for `server_error` (5xx) instead of
 * connection-level failures; 503-with-upstream-rate-limit is already absorbed
 * upstream as `upstream_rate_limited`.
 */

import consola from "consola"

import type { ApiError } from "~/lib/error"

import type {
  //
  RetryAction,
  RetryContext,
  RetryStrategy,
} from "../pipeline"

/** Max server-error retries per pipeline execution */
const SERVER_ERROR_MAX_RETRIES = 2

/** Base delay before server-error retry (ms); doubled per attempt */
const SERVER_ERROR_BASE_DELAY_MS = 1000

/**
 * Create a 5xx server-error retry strategy.
 *
 * On `server_error` (502/504/500…), waits with exponential backoff then retries
 * the same payload, up to {@link SERVER_ERROR_MAX_RETRIES} times. Persistent 5xx
 * (request genuinely rejected) falls through to FAIL once the budget is spent.
 */
export function createServerErrorRetryStrategy<TPayload>(): RetryStrategy<TPayload> {
  let retries = 0

  return {
    name: "server-error-retry",

    canHandle(error: ApiError): boolean {
      return error.type === "server_error" && retries < SERVER_ERROR_MAX_RETRIES
    },

    handle(error: ApiError, currentPayload: TPayload, context: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      const waitMs = SERVER_ERROR_BASE_DELAY_MS * 2 ** retries
      retries += 1

      consola.info(
        `[ServerErrorRetry] Attempt ${context.attempt + 1}/${context.maxRetries + 1}: `
          + `HTTP ${error.status} "${error.message}", retrying in ${waitMs}ms (${retries}/${SERVER_ERROR_MAX_RETRIES})...`,
      )

      return Promise.resolve({
        action: "retry",
        payload: currentPayload,
        waitMs,
        meta: { serverErrorRetry: true },
      })
    },
  }
}
