/**
 * Retryable transport error strategy.
 *
 * Handles transient connection failures (ECONNRESET, ETIMEDOUT, socket closures, etc.) and upstream HTTP 499 responses with an empty body by retrying once after a brief delay.
 * A single retry bounds duplicate-processing exposure while recovering from transient transport and gateway failures.
 */

import consola from "consola"

import type { ApiError } from "~/lib/error"

import type {
  //
  RetryAction,
  RetryContext,
  RetryStrategy,
} from "../retry-types"

/** Default delay before network retry (ms) */
const NETWORK_RETRY_DELAY_MS = 1000

/**
 * Create a retryable transport error strategy.
 *
 * On `network_error` (connection failures or an upstream empty-body HTTP 499), waits briefly and retries with the same payload.
 * Only retries once per pipeline execution to avoid prolonged retry loops on persistent failures.
 */
export function createNetworkRetryStrategy<TPayload>(): RetryStrategy<TPayload> {
  // Track whether we've already attempted a network retry.
  // A second network error after retry means the problem is persistent.
  let hasRetried = false

  return {
    name: "network-retry",

    canHandle(error: ApiError): boolean {
      return error.type === "network_error" && !hasRetried
    },

    handle(error: ApiError, currentPayload: TPayload, context: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      consola.info(
        `[NetworkRetry] Attempt ${context.attempt + 1}/${context.maxRetries + 1}: `
          + `Retryable transport error "${error.message}", retrying in ${NETWORK_RETRY_DELAY_MS}ms...`,
      )

      hasRetried = true

      return Promise.resolve({
        action: "retry",
        payload: currentPayload,
        waitMs: NETWORK_RETRY_DELAY_MS,
        meta: { networkRetry: true },
      })
    },
  }
}
