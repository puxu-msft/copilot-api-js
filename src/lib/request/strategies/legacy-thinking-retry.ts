/**
 * Legacy thinking normalization retry strategy.
 *
 * Reactive safety net for the upstream 400 raised when a request sends the
 * pre-adaptive thinking shape (`thinking: { type: "enabled", budget_tokens }`)
 * to a model that only supports adaptive thinking:
 *
 *   HTTP 400: "thinking.type.enabled" is not supported for this model.
 *   Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
 *
 * The primary fix is the prepare-time `coerceAdaptiveThinking` transform
 * (request-preparation.ts), gated on model-capability detection. This strategy
 * is the fallback for when that detection misses (metadata absent AND name not
 * in the allowlist): on the 400, rewrite `thinking` to `{ type: "adaptive" }`
 * and retry once. Re-preparation sees the already-adaptive shape and leaves it
 * untouched, so there is no double-conversion.
 */

import type { ApiError } from "~/lib/error"

import { HTTPError } from "~/lib/error"

import type {
  //
  RetryAction,
  RetryContext,
  RetryStrategy,
} from "../retry-types"

/**
 * Match the adaptive-only rejection. The upstream phrasing names the offending
 * field (`thinking.type.enabled`) and either "is not supported" or directs to
 * "adaptive"; require both the field token and an adaptive/unsupported cue so an
 * unrelated 400 mentioning "thinking" can't trigger a spurious rewrite.
 */
function isLegacyThinkingRejection(message: string): boolean {
  const lower = message.toLowerCase()
  if (!lower.includes("thinking.type.enabled")) return false
  return lower.includes("not supported") || lower.includes("adaptive")
}

/** Extract the upstream error message, unwrapping a JSON `error.message` envelope. */
function extractErrorMessage(error: ApiError): string | null {
  if (isLegacyThinkingRejection(error.message)) return error.message

  if (!(error.raw instanceof HTTPError)) return null
  const responseText = error.raw.responseText

  try {
    const parsed = JSON.parse(responseText) as { error?: { message?: string } }
    return parsed.error?.message ?? responseText
  } catch {
    return responseText
  }
}

export function createLegacyThinkingRetryStrategy<
  TPayload extends {
    model: string
    thinking?: { type?: string; display?: string | null; budget_tokens?: number } | null
  },
>(): RetryStrategy<TPayload> {
  return {
    name: "legacy-thinking-retry",

    canHandle(error: ApiError): boolean {
      if (error.type !== "bad_request" || error.status !== 400) return false
      const message = extractErrorMessage(error)
      return message ? isLegacyThinkingRejection(message) : false
    },

    handle(error: ApiError, currentPayload: TPayload, _context: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      const thinking = currentPayload.thinking
      // Already adaptive (or no thinking) — re-converting would loop; bail out.
      if (!thinking || thinking.type === "adaptive") {
        return Promise.resolve({ action: "abort", error })
      }

      // Preserve `display` (summarized/omitted) for multi-turn signature continuity.
      const display = thinking.display
      const nextPayload: TPayload = {
        ...currentPayload,
        thinking: { type: "adaptive", ...(display ? { display } : {}) },
      }

      return Promise.resolve({
        action: "retry",
        payload: nextPayload,
        meta: { coercedAdaptiveThinking: true },
      })
    },
  }
}
