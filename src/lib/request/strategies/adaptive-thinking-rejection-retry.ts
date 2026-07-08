/**
 * Adaptive-thinking rejection retry strategy.
 *
 * Reactive safety net (the mirror of `legacy-thinking-retry`) for the upstream
 * 400 raised when a request sends `thinking: { type: "adaptive" }` to a model
 * that only accepts the budget-based (enabled) thinking shape:
 *
 *   HTTP 400: adaptive thinking is not supported on this model
 *
 * Newer clients (e.g. Claude Code whose main model is an adaptive opus) reuse
 * their `adaptive` thinking config for fast subagent calls routed to a
 * non-adaptive model (e.g. haiku-4.5), producing this 400.
 *
 * The primary fix is the prepare-time `coerceEnabledThinking` transform
 * (request-preparation.ts), gated on positive enabled-only model metadata. This
 * strategy is the fallback for when that detection abstains (metadata silent):
 * on the 400, rewrite `thinking` to the enabled shape (folding
 * `output_config.effort` into `budget_tokens`) and retry once. Re-preparation's
 * `adjustThinkingBudget` clamps the synthesized budget to the model window, and
 * `coerceEnabledThinking` leaves an already-enabled shape untouched, so there is
 * no double-conversion.
 *
 * Like `legacy-thinking-retry`, this reactive net is ALWAYS ON — it acts on a
 * ground-truth upstream 400, so it is intentionally NOT gated by the
 * `anthropic.thinking_coerce_adaptive` config (that flag disables only the
 * PREDICTIVE prepare-time coercion). Disabling the config means the fix is
 * deferred to this retry rather than removed; the coercion stays traceable via
 * the `coercedEnabledThinking` retry meta + the recorded thinking feature delta.
 */

import type { ApiError } from "~/lib/error"

import { adaptiveToEnabledThinking } from "~/lib/anthropic/thinking-coercion"
import { HTTPError } from "~/lib/error"

import type {
  //
  RetryAction,
  RetryContext,
  RetryStrategy,
} from "../pipeline"

/**
 * Match the adaptive-not-supported rejection. The upstream phrasing is stable
 * ("adaptive thinking is not supported on this model"); the substring is
 * specific enough that no unrelated 400 can trigger a spurious rewrite, and it
 * is disjoint from `legacy-thinking-retry`'s `thinking.type.enabled` matcher.
 */
function isAdaptiveNotSupportedRejection(message: string): boolean {
  return message.toLowerCase().includes("adaptive thinking is not supported")
}

/** Extract the upstream error message, unwrapping a JSON `error.message` envelope. */
function extractErrorMessage(error: ApiError): string | null {
  if (isAdaptiveNotSupportedRejection(error.message)) return error.message

  if (!(error.raw instanceof HTTPError)) return null
  const responseText = error.raw.responseText

  try {
    const parsed = JSON.parse(responseText) as { error?: { message?: string } }
    return parsed.error?.message ?? responseText
  } catch {
    return responseText
  }
}

export function createAdaptiveThinkingRejectionRetryStrategy<
  TPayload extends {
    model: string
    thinking?: { type?: string; display?: string | null; budget_tokens?: number } | null
    output_config?: { effort?: string } | null
  },
>(): RetryStrategy<TPayload> {
  return {
    name: "adaptive-thinking-rejection-retry",

    canHandle(error: ApiError): boolean {
      if (error.type !== "bad_request" || error.status !== 400) return false
      const message = extractErrorMessage(error)
      return message ? isAdaptiveNotSupportedRejection(message) : false
    },

    handle(error: ApiError, currentPayload: TPayload, _context: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      const thinking = currentPayload.thinking
      // Not adaptive (or no thinking) — re-converting would loop; bail out. After
      // one rewrite the shape is `enabled`, so a repeated 400 lands here and aborts.
      if (!thinking || thinking.type !== "adaptive") {
        return Promise.resolve({ action: "abort", error })
      }

      const outputConfig = currentPayload.output_config
      const display = thinking.display
      const nextPayload: TPayload = {
        ...currentPayload,
        thinking: adaptiveToEnabledThinking(outputConfig?.effort, display),
      }

      // Drop the adaptive-only `effort` now folded into budget_tokens; preserve
      // any other output_config fields (e.g. format).
      if (outputConfig?.effort !== undefined) {
        const { effort: _effort, ...rest } = outputConfig
        nextPayload.output_config = Object.keys(rest).length === 0 ? undefined : rest
      }

      return Promise.resolve({
        action: "retry",
        payload: nextPayload,
        meta: { coercedEnabledThinking: true },
      })
    },
  }
}
