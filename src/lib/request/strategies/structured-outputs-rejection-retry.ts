/**
 * Structured-outputs rejection retry strategy.
 *
 * Some GHC accounts route Claude requests to Vertex AI, where the org policy
 * `constraints/vertexai.allowedPartnerModelFeatures` can disallow the
 * `structured_outputs` partner feature. A client that sends
 * `output_config.format` (Anthropic structured outputs — e.g. Claude Code's
 * conversation-title generator, which asks for a `{ title }` JSON schema) then
 * gets a hard 400:
 *
 *   HTTP 400 [{"error":{"code":400,"message":"Organization Policy constraint
 *     constraints/vertexai.allowedPartnerModelFeatures violated for
 *     `projects/...` attempting to use a disallowed feature structured_outputs
 *     for Partner model claude-sonnet-4-6. ...","status":"FAILED_PRECONDITION"}}]
 *
 * No other retry strategy's `canHandle` matches this error shape, so without
 * this strategy the request fails outright and title generation (and any other
 * structured-output request) breaks.
 *
 * Reactive self-healing (mirrors `server-tool-rejection-retry`): on the first
 * 400 we strip `output_config.format` from the payload and retry. The request
 * gracefully degrades to free-form output — title generation still works
 * because the system prompt already instructs the model to return JSON. We also
 * fixate `structured_outputs` in the negotiation cache so future
 * same-(endpoint, model) requests pre-emptively strip the field during prepare
 * (`stripUnsupportedStructuredOutputs`), avoiding a repeated failed round-trip.
 *
 * Scope: only `structured_outputs` is handled — it is the sole partner feature
 * with a known, safe strip target (`output_config.format`). Other disallowed
 * features fall through to a plain 400 (we can't safely guess what to remove).
 */

import type { OutputConfig } from "~/types/api/anthropic"

import {
  //
  markAnthropicPartnerFeatureUnsupported,
  STRUCTURED_OUTPUTS_PARTNER_FEATURE,
} from "~/lib/anthropic/feature-negotiation"
import {
  //
  type ApiError,
  HTTPError,
} from "~/lib/error"

import type {
  //
  RetryAction,
  RetryContext,
  RetryStrategy,
} from "../pipeline"

/** Guard: the Vertex org-policy class for partner-model feature gating. */
const PARTNER_FEATURE_VIOLATION = /allowedPartnerModelFeatures/i

/** Capture the disallowed feature name from `... disallowed feature <name> ...`. */
const DISALLOWED_FEATURE = /disallowed feature\s+([a-z_]\w*)/i

function extractErrorText(error: ApiError): string | null {
  // The wrapped `message` is the laconic "HTTP 400: Failed to create chat
  // completions"; the org-policy detail lives in the raw HTTPError responseText
  // (a JSON array `[{"error":{"message":"..."}}]`).
  if (PARTNER_FEATURE_VIOLATION.test(error.message)) return error.message
  if (error.raw instanceof HTTPError) return error.raw.responseText
  return null
}

/** Extract the disallowed partner feature name, or null when not this error class. */
export function parseDisallowedPartnerFeature(error: ApiError): string | null {
  const text = extractErrorText(error)
  if (!text || !PARTNER_FEATURE_VIOLATION.test(text)) return null
  return DISALLOWED_FEATURE.exec(text)?.[1] ?? null
}

/** Remove `format` from `output_config`, dropping `output_config` if it empties. */
function stripStructuredOutputFormat<TPayload extends { output_config?: OutputConfig }>(payload: TPayload): TPayload {
  const outputConfig = payload.output_config
  if (!outputConfig || outputConfig.format === undefined) return payload

  const { format: _format, ...rest } = outputConfig
  return {
    ...payload,
    output_config: Object.keys(rest).length > 0 ? rest : undefined,
  }
}

export function createStructuredOutputsRejectionStrategy<TPayload extends { model: string; output_config?: OutputConfig }>(): RetryStrategy<TPayload> {
  // Per-instance one-shot guard. Strategies are built per-request, so this is
  // request-scoped and cannot leak across unrelated requests.
  let attempted = false

  return {
    name: "structured-outputs-rejection-retry",

    canHandle(error: ApiError): boolean {
      if (error.type !== "bad_request" || error.status !== 400) return false
      if (attempted) return false
      // Only `structured_outputs` has a known safe strip target. Let any other
      // disallowed partner feature fall through to a plain 400.
      return parseDisallowedPartnerFeature(error) === STRUCTURED_OUTPUTS_PARTNER_FEATURE
    },

    handle(_error: ApiError, currentPayload: TPayload, _context: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      attempted = true
      markAnthropicPartnerFeatureUnsupported(currentPayload.model, STRUCTURED_OUTPUTS_PARTNER_FEATURE)
      return Promise.resolve({
        action: "retry",
        payload: stripStructuredOutputFormat(currentPayload),
        meta: { strippedPartnerFeature: STRUCTURED_OUTPUTS_PARTNER_FEATURE },
      })
    },
  }
}
