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
 * (`strip-partner-features`), avoiding a repeated failed round-trip.
 *
 * Proactive twin: the operator can also pre-declare disallowed partner features
 * in config (`anthropic.partner_strip_features: { <model>: [structured_outputs] }`);
 * the prepare step unions config ∪ this learned cache (same shape as
 * `beta_strip_headers` ∪ the beta cache), so a declared model strips on the FIRST
 * request without paying this reactive 400 + degrade-warn round-trip.
 *
 * Table-driven extension point — **only `structured_outputs` is in the table
 * today** (`PARTNER_FEATURE_STRIP_TARGETS`, the single table shared with the
 * prepare step):
 *   - Current behavior: any OTHER disallowed partner feature
 *     (`extended_thinking`, `vision`, `prompt_caching`, …) is parsed by
 *     `parseDisallowedPartnerFeature` but `canHandle` returns false for it (no
 *     table row), so the request still fails with a plain 400.
 *   - Why: `structured_outputs` is the only feature with empirical evidence AND
 *     a known, safe strip target (`output_config.format`). The other features
 *     have no obvious "remove this one field and the request is still valid"
 *     mapping, and stripping the wrong thing would silently change request
 *     semantics. We don't speculatively guess.
 *   - To extend: add a row to `PARTNER_FEATURE_STRIP_TARGETS` (feature name →
 *     wire strip descriptor). That single data change lights up BOTH this
 *     reactive strategy (`canHandle` + `handle`) and the prepare step
 *     (`strip-partner-features`), which iterate the same table. The
 *     identification half (`parseDisallowedPartnerFeature`) is already
 *     feature-agnostic.
 *
 * Note: stripping `structured_outputs` drops the client's JSON-schema guarantee
 * (degrade to free-form). The real fix is on the user's side — allow the feature
 * in the Vertex org policy; the negotiation-cache fixation is permanent until
 * `negotiation-states.json` is cleared, so a user who later allow-lists the
 * feature must delete that entry to re-enable structured outputs.
 */

import consola from "consola"

import type { OutputConfig } from "~/types/api/anthropic"

import {
  //
  markAnthropicPartnerFeatureUnsupported,
  STRUCTURED_OUTPUTS_PARTNER_FEATURE,
} from "~/lib/anthropic/feature-negotiation"
import {
  //
  PARTNER_FEATURE_STRIP_TARGETS,
  stripPartnerFeatureFromWire,
} from "~/lib/anthropic/partner-feature-strip"
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
} from "../retry-types"

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

export function createStructuredOutputsRejectionStrategy<TPayload extends { model: string; output_config?: OutputConfig }>(): RetryStrategy<TPayload> {
  // Per-instance one-shot guard. Strategies are built per-request, so this is
  // request-scoped and cannot leak across unrelated requests.
  let attempted = false

  return {
    name: "structured-outputs-rejection-retry",

    canHandle(error: ApiError): boolean {
      if (error.type !== "bad_request" || error.status !== 400) return false
      if (attempted) return false
      // Accept any disallowed partner feature that has a KNOWN SAFE strip target
      // (i.e. is a row in PARTNER_FEATURE_STRIP_TARGETS). Others fall through to
      // a plain 400 — we don't speculatively strip an unknown wire field.
      const feature = parseDisallowedPartnerFeature(error)
      return feature !== null && Object.hasOwn(PARTNER_FEATURE_STRIP_TARGETS, feature)
    },

    handle(error: ApiError, currentPayload: TPayload, _context: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      attempted = true
      // canHandle guarantees a table-matched feature; default defensively.
      const feature = parseDisallowedPartnerFeature(error) ?? STRUCTURED_OUTPUTS_PARTNER_FEATURE
      markAnthropicPartnerFeatureUnsupported(currentPayload.model, feature)
      if (feature === STRUCTURED_OUTPUTS_PARTNER_FEATURE) {
        // One-shot per request (the `attempted` guard above): surface WHY the
        // response silently loses its JSON-schema guarantee, and how to restore it.
        consola.warn(
          `[StructuredOutputs] Upstream org policy disallows "${STRUCTURED_OUTPUTS_PARTNER_FEATURE}" for ${currentPayload.model}; `
            + `stripped output_config.format and retrying — the response degrades to free-form (no schema guarantee). `
            + `To restore: allow the feature in your Vertex AI org policy (allowedPartnerModelFeatures), then clear the `
            + `negotiation cache entry (negotiation-states.json) so it is re-tested.`,
        )
      }
      // Shallow-clone then strip via the shared table-driven primitive: the strip
      // reassigns/deletes the top-level field, never mutating nested objects, so
      // the caller's original payload is untouched.
      const next = { ...currentPayload }
      stripPartnerFeatureFromWire(next as Record<string, unknown>, feature)
      return Promise.resolve({
        action: "retry",
        payload: next,
        meta: { strippedPartnerFeature: feature },
      })
    },
  }
}
