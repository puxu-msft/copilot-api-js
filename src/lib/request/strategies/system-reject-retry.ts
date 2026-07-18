/**
 * System-reject retry strategy (RFC gap A).
 *
 * The Anthropic Messages API rejects inline `role:"system"` messages with
 * `Unexpected role "system"`. GHC's lenient first-party path hoists them before
 * forwarding; the STRICT path (Vertex / partner) sends canonical validation and
 * 400s. This strategy reacts to that 400: learn the model into the negotiation
 * `systemRejectModels` set (persisted), then re-run the S3 sanitize chain on the
 * PRE-S3 baseline (`context.originalPayload`) — the effective inline-system mode
 * now resolves to `system_reject_mode` for the just-learned model, so sanitize
 * rewrites role:system → user and the retry ships a clean payload.
 *
 * Re-sanitize arm of the reactive-rejection primitive (mirrors auto-truncate's
 * resanitize(originalPayload)). Feeding `context.originalPayload` is a CORRECTNESS
 * hard-constraint (RFC O6 / §3.2 WARN-1): feeding the already-S3 currentPayload
 * would double-apply the whole rewrite chain. Learned reason is logged as an
 * INFERENCE ("Vertex is this account's known cause but not asserted").
 */

import consola from "consola"

import type { AnthropicSanitizeFn } from "~/lib/anthropic/pipeline"
import type { ApiError } from "~/lib/error"
import type { MessagesPayload } from "~/types/api/anthropic"

import { markSystemRejectModel } from "~/lib/anthropic/feature-negotiation"
import { HTTPError } from "~/lib/error"
import { createReactiveRejectionStrategy } from "~/lib/request/strategies/reactive-rejection"

import type { RetryStrategy } from "../retry-types"

/**
 * Upstream message for an inline role:"system" rejection.
 *
 * Tolerates BOTH forms the token can arrive in: the parsed `error.message`
 * (`Unexpected role "system"`) and the RAW `HTTPError.responseText`, which is
 * the untouched JSON body where the inner quotes are backslash-escaped
 * (`Unexpected role \"system\"`). Since the effective carrier here is the raw
 * responseText (the wrapped `error.message` is the laconic "HTTP 400: Failed to
 * create Anthropic messages"), `\\?` before each quote is load-bearing — without
 * it the strategy never matches the real wire.
 */
const UNEXPECTED_SYSTEM_ROLE = /Unexpected role \\?"system\\?"/i

function extractErrorText(error: ApiError): string | null {
  if (UNEXPECTED_SYSTEM_ROLE.test(error.message)) return error.message
  if (error.raw instanceof HTTPError) return error.raw.responseText
  return null
}

export interface SystemRejectRetryDeps {
  resanitize: AnthropicSanitizeFn
  mark?: (model: string) => void
}

export function createSystemRejectRetryStrategy<TPayload extends MessagesPayload>(deps: SystemRejectRetryDeps): RetryStrategy<TPayload> {
  const mark = deps.mark ?? markSystemRejectModel
  return createReactiveRejectionStrategy<TPayload>({
    name: "system-reject-retry",
    match: (error) => {
      const text = extractErrorText(error)
      return text !== null && UNEXPECTED_SYSTEM_ROLE.test(text) ? "role:system" : null
    },
    mark: (model) => {
      mark(model)
      consola.info(
        `[SystemReject] Inferred inline role:system rejection for ${model} (Vertex is this account's known cause but not asserted); re-sanitizing + retrying.`,
      )
    },
    remediate: ({ context }) => {
      // Re-run the S3 chain on the PRE-S3 baseline — the effective mode now
      // rewrites role:system for the just-learned model. NEVER feed currentPayload
      // (already-S3 → double-apply). Mirrors auto-truncate resanitize(originalPayload).
      const result = deps.resanitize(context.originalPayload)
      return { action: "retry", payload: result.payload as TPayload, meta: { sanitization: result.stats } }
    },
  })
}
