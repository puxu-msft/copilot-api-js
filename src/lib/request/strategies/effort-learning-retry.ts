/**
 * Effort-learning retry strategy.
 *
 * Reactive learner for the upstream 400 `invalid_reasoning_effort` raised when a
 * request's `output_config.effort` is not in the model's supported set:
 *
 *   HTTP 400 { code: "invalid_reasoning_effort",
 *     message: 'output_config.effort "high" is not supported by model X; supported values: [medium]' }
 *
 * On that error it parses the supported values out of the body, persists them to
 * the negotiation cache (`learnEffortsFromError`), and retries once. Re-preparation
 * on the retried attempt (`prepareAnthropicRequest` → `clampEffortLevel`) reads the
 * freshly-learned whitelist and clamps the effort, so the next wire payload uses a
 * supported value.
 *
 * Lifted from the Anthropic client's 2-attempt inner loop (v4 P0.4): retrying is
 * now driven by the pipeline, so every retry strategy lives in one place and the
 * client degenerates to a single send/receive. Assembled into
 * `buildAnthropicStrategies` after network/token-refresh and before the other
 * 400-class strategies (their messages are mutually exclusive, so order is safe).
 */

import type { ApiError } from "~/lib/error"

import { learnEffortsFromError } from "~/lib/anthropic/request-preparation"
import { HTTPError } from "~/lib/error"

import type {
  //
  RetryAction,
  RetryContext,
  RetryStrategy,
} from "../pipeline"

/** Pull the raw upstream response body — where the `invalid_reasoning_effort` code lives. */
function responseBodyOf(error: ApiError): string | null {
  if (error.raw instanceof HTTPError) return error.raw.responseText
  return null
}

export interface EffortLearningRetryDeps {
  /**
   * Learn supported efforts from the upstream error body, returning whether the
   * negotiation cache was updated (and thus a retry is worthwhile). Injectable
   * for testing; defaults to the real cache-mutating `learnEffortsFromError`.
   */
  learn?: (responseText: string) => boolean
}

export function createEffortLearningRetryStrategy<TPayload>(deps?: EffortLearningRetryDeps): RetryStrategy<TPayload> {
  const learn = deps?.learn ?? learnEffortsFromError
  // One-shot, mirroring the old `attempt === 0` guard: learn + retry at most
  // once. A successful learn clamps the effort, so a second
  // `invalid_reasoning_effort` should not recur; the flag bounds the strategy
  // defensively regardless of upstream behavior.
  let attempted = false
  return {
    name: "effort-learning",

    canHandle(error: ApiError): boolean {
      if (attempted) return false
      if (error.type !== "bad_request" || error.status !== 400) return false
      const body = responseBodyOf(error)
      return body !== null && body.includes("invalid_reasoning_effort")
    },

    handle(error: ApiError, currentPayload: TPayload, _context: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      attempted = true
      const body = responseBodyOf(error)
      // Learn the supported efforts into the negotiation cache. Re-preparation on
      // the retried attempt reads them and clamps `output_config.effort`, so the
      // same (unchanged) payload re-prepares to a supported effort.
      if (body && learn(body)) {
        return Promise.resolve({ action: "retry", payload: currentPayload })
      }
      // Nothing learnable (already known, or unparseable) — don't loop.
      return Promise.resolve({ action: "abort", error })
    },
  }
}
