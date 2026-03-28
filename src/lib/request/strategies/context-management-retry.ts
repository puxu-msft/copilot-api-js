/**
 * Context management retry strategy.
 *
 * Handles 400 errors where the upstream proxy rejects the Anthropic
 * `context_management` request field as an unknown/unsupported extra input.
 *
 * Some upstreams lag behind Anthropic feature rollout or support the beta
 * header but not the body field. In that case we retry once with
 * `context_management` explicitly disabled for that payload only.
 */

import type { ApiError } from "~/lib/error"

import { markAnthropicFeatureUnsupported } from "~/lib/anthropic/feature-negotiation"

import type { RetryAction, RetryContext, RetryStrategy } from "../pipeline"

const EXTRA_INPUTS_PATTERN = /context_management:\s*Extra inputs are not permitted/i

export function parseContextManagementExtraInputsError(message: string): boolean {
  return EXTRA_INPUTS_PATTERN.test(message)
}

function extractErrorMessage(error: ApiError): string | null {
  if (parseContextManagementExtraInputsError(error.message)) {
    return error.message
  }

  const raw = error.raw
  if (!raw || typeof raw !== "object" || !("responseText" in raw) || typeof raw.responseText !== "string") {
    return null
  }

  try {
    const parsed = JSON.parse(raw.responseText) as { error?: { message?: string } }
    return parsed.error?.message ?? raw.responseText
  } catch {
    return raw.responseText
  }
}

export function createContextManagementRetryStrategy<
  TPayload extends {
    model: string
    context_management?: Record<string, unknown> | null
  },
>(): RetryStrategy<TPayload> {
  return {
    name: "context-management-retry",

    canHandle(error: ApiError): boolean {
      if (error.type !== "bad_request" || error.status !== 400) return false
      const message = extractErrorMessage(error)
      return message ? parseContextManagementExtraInputsError(message) : false
    },

    handle(error: ApiError, currentPayload: TPayload, _context: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      markAnthropicFeatureUnsupported(currentPayload.model, "context_management")

      if (currentPayload.context_management === null) {
        return Promise.resolve({ action: "abort", error })
      }

      return Promise.resolve({
        action: "retry",
        payload: {
          ...currentPayload,
          context_management: null,
        },
        meta: {
          disabledContextManagement: true,
        },
      })
    },
  }
}
