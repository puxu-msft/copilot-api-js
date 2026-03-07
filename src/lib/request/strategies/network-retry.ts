/**
 * Network error retry strategy.
 *
 * Handles transient network errors (ECONNRESET, ETIMEDOUT, socket closures, etc.)
 * by retrying once after a brief delay. These errors are typically caused by
 * connection pool issues, transient network glitches, or upstream resets,
 * and a single retry usually succeeds.
 */

import consola from "consola"

import type { ApiError } from "~/lib/error"

import type { RetryAction, RetryContext, RetryStrategy } from "../pipeline"

/** Default delay before network retry (ms) */
const NETWORK_RETRY_DELAY_MS = 1000

/**
 * Create a network error retry strategy.
 *
 * On `network_error` (ECONNRESET, ETIMEDOUT, socket closures, DNS timeouts, etc.),
 * waits briefly then retries with the same payload.
 * Only retries once per pipeline execution to avoid prolonged retry loops
 * on persistent network failures.
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
          + `Network error "${error.message}", retrying in ${NETWORK_RETRY_DELAY_MS}ms...`,
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
