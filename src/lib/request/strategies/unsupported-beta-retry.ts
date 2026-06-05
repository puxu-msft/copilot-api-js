/**
 * Unsupported `anthropic-beta` header retry strategy.
 *
 * GHC's upstream rejects unknown / model-incompatible beta header tokens
 * with HTTP 400: `unsupported beta header(s): X[, Y]`. On detection, this
 * strategy:
 *
 *   1. Returns a `PrepareHints.excludeBetas` list so the pipeline forwards
 *      "drop these betas on the next prep" to `prepareAnthropicRequest`
 *      deterministically — independent of any global cache. This is the
 *      authoritative signal for the IN-FLIGHT retry.
 *
 *   2. Also marks the tokens in the persistent negotiation cache so FUTURE
 *      independent requests pre-emptively strip them on the very first
 *      attempt (cross-request memo, not used by the in-flight retry).
 *
 * The two responsibilities are now decoupled: a future change to adapter
 * caching / preparation memoization cannot silently break this strategy,
 * because intra-retry exclusion travels in the explicit hint channel.
 */

import type { ApiError } from "~/lib/error"

import { markAnthropicBetaUnsupported } from "~/lib/anthropic/feature-negotiation"
import { HTTPError } from "~/lib/error"

import type {
  //
  RetryAction,
  RetryContext,
  RetryStrategy,
} from "../pipeline"

const UNSUPPORTED_BETA_PATTERN = /unsupported beta header\(s\):\s*([^"}]+)/i

function extractErrorText(error: ApiError): string | null {
  if (UNSUPPORTED_BETA_PATTERN.test(error.message)) return error.message
  if (error.raw instanceof HTTPError) return error.raw.responseText
  return null
}

export function parseUnsupportedBetas(text: string): Array<string> {
  const match = UNSUPPORTED_BETA_PATTERN.exec(text)
  if (!match) return []
  return match[1]
    .split(",")
    .map((s) => s.trim().replaceAll(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0)
}

export function createUnsupportedBetaRetryStrategy<TPayload extends { model: string }>(): RetryStrategy<TPayload> {
  return {
    name: "unsupported-beta-retry",

    canHandle(error: ApiError): boolean {
      if (error.type !== "bad_request" || error.status !== 400) return false
      const text = extractErrorText(error)
      return text ? parseUnsupportedBetas(text).length > 0 : false
    },

    handle(
      error: ApiError,
      currentPayload: TPayload,
      _context: RetryContext<TPayload>,
    ): Promise<RetryAction<TPayload>> {
      const text = extractErrorText(error)
      const betas = text ? parseUnsupportedBetas(text) : []
      if (betas.length === 0) {
        return Promise.resolve({ action: "abort", error })
      }

      // Persist for future independent requests.
      for (const beta of betas) {
        markAnthropicBetaUnsupported(currentPayload.model, beta)
      }

      // Authoritative signal for THIS retry: tell the next prep step exactly
      // which tokens to drop. The pipeline forwards `prepareHints` to the
      // adapter, which forwards `excludeBetas` to `prepareAnthropicRequest`.
      return Promise.resolve({
        action: "retry",
        payload: currentPayload,
        prepareHints: { excludeBetas: betas },
        meta: { strippedBetas: betas },
      })
    },
  }
}
