/**
 * Body-field rejection retry strategy (generic).
 *
 * Handles 400 errors where the upstream proxy rejects a body field as an
 * unknown/extra input — e.g.
 *   `context_management: Extra inputs are not permitted`
 *   `inference_geo: Extra inputs are not permitted`
 *
 * The field is recorded in the persistent negotiation cache so future
 * requests pre-emptively strip it (see `collectRejectedFields` in
 * `request-preparation.ts`). On retry, the same payload is re-prepared
 * with the field absent.
 *
 * Backwards-compatible re-export: `createContextManagementRetryStrategy`
 * is preserved as an alias of `createBodyFieldRejectionStrategy` for
 * existing call sites and tests.
 */

import type { ApiError } from "~/lib/error"

import { markAnthropicFeatureUnsupported } from "~/lib/anthropic/feature-negotiation"

import type {
  //
  RetryAction,
  RetryContext,
  RetryStrategy,
} from "../pipeline"

// Matches "<field>: Extra inputs are not permitted" with <field> = identifier
// (snake/camel case). Restricting to identifier characters avoids false matches
// in unrelated free-text messages.
const EXTRA_INPUTS_PATTERN = /\b([a-z_]\w*):\s*Extra inputs are not permitted/i

export interface ExtraInputsErrorInfo {
  /** The rejected body field name (e.g. "context_management") */
  field: string
  /** Whether the field name was extracted from the error */
  raw: string
}

export function parseExtraInputsError(message: string): ExtraInputsErrorInfo | null {
  const match = EXTRA_INPUTS_PATTERN.exec(message)
  if (!match) return null
  return { field: match[1], raw: match[0] }
}

/** @deprecated Use parseExtraInputsError */
export function parseContextManagementExtraInputsError(message: string): boolean {
  const parsed = parseExtraInputsError(message)
  return parsed?.field === "context_management"
}

function extractErrorMessage(error: ApiError): string | null {
  if (parseExtraInputsError(error.message)) return error.message

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

export function createBodyFieldRejectionStrategy<
  TPayload extends {
    model: string
    context_management?: Record<string, unknown> | null
  },
>(): RetryStrategy<TPayload> {
  return {
    name: "body-field-rejection-retry",

    canHandle(error: ApiError): boolean {
      if (error.type !== "bad_request" || error.status !== 400) return false
      const message = extractErrorMessage(error)
      return message ? parseExtraInputsError(message) !== null : false
    },

    handle(
      error: ApiError,
      currentPayload: TPayload,
      _context: RetryContext<TPayload>,
    ): Promise<RetryAction<TPayload>> {
      const message = extractErrorMessage(error)
      const parsed = message ? parseExtraInputsError(message) : null
      if (!parsed) {
        return Promise.resolve({ action: "abort", error })
      }

      markAnthropicFeatureUnsupported(currentPayload.model, parsed.field)

      // For context_management we also want to suppress the field in the next
      // payload via the explicit `null` marker — keeps the "client opt-out"
      // semantics inside prepareAnthropicRequest consistent.
      if (parsed.field === "context_management" && currentPayload.context_management === null) {
        return Promise.resolve({ action: "abort", error })
      }

      const nextPayload: TPayload =
        parsed.field === "context_management" ?
          ({ ...currentPayload, context_management: null } as TPayload)
        : ({ ...currentPayload, [parsed.field]: undefined } as TPayload)

      return Promise.resolve({
        action: "retry",
        payload: nextPayload,
        // PrepareHints (H4 contract): even though we've physically removed the
        // field from `nextPayload`, also signal it in the explicit hint
        // channel. This makes the retry intent visible to any future adapter
        // memoization or prep-layer optimization and aligns with the sibling
        // unsupported-beta-retry strategy. The negotiation cache mark above
        // is kept as the cross-request memo (a NEW future request to the
        // same model pre-emptively strips this field on first prep).
        prepareHints: { rejectFields: [parsed.field] },
        meta: {
          rejectedField: parsed.field,
          ...(parsed.field === "context_management" && { disabledContextManagement: true }),
        },
      })
    },
  }
}

/** @deprecated Use createBodyFieldRejectionStrategy */
export const createContextManagementRetryStrategy = createBodyFieldRejectionStrategy
