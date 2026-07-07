/**
 * Generic reactive-rejection retry primitive.
 *
 * Unifies the shared shape of the per-model upstream-rejection strategies
 * (system-reject / web_search-not-found / partner-feature / server-tool):
 * detect a specific 400 → parse a capability token → persist it to the
 * negotiation cache → remediate (re-sanitize the pre-S3 baseline, OR strip a
 * field / carry prepareHints) → retry once.
 *
 * Two remediation arms (RFC §3.1 WARN-7): the re-sanitize arm (system-reject /
 * web_search-history) re-runs the S3 chain on `context.originalPayload`; the
 * strip arm (partner-feature / server-tool) mutates the payload or sets
 * prepareHints. The primitive owns parse/mark/canHandle/one-shot; the caller
 * injects the remediation.
 */

import type { ApiError } from "~/lib/error"

import type {
  //
  RetryAction,
  RetryContext,
  RetryStrategy,
} from "../pipeline"

export interface ReactiveRejectionConfig<TPayload extends { model: string }> {
  name: string
  match(error: ApiError): string | null
  mark(model: string, token: string): void
  remediate(args: { error: ApiError; payload: TPayload; token: string; context: RetryContext<TPayload> }): RetryAction<TPayload>
}

export function createReactiveRejectionStrategy<TPayload extends { model: string }>(cfg: ReactiveRejectionConfig<TPayload>): RetryStrategy<TPayload> {
  // Per-instance one-shot guard. Strategies are built per-request (see
  // buildAnthropicStrategies), so this is request-scoped and cannot leak across
  // unrelated requests. Defense-in-depth alongside the idempotent cache mark.
  let attempted = false

  return {
    name: cfg.name,

    canHandle(error: ApiError): boolean {
      if (attempted) return false
      if (error.type !== "bad_request" || error.status !== 400) return false
      return cfg.match(error) !== null
    },

    handle(error: ApiError, currentPayload: TPayload, context: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      attempted = true
      const token = cfg.match(error)
      if (token === null) return Promise.resolve({ action: "abort", error })
      cfg.mark(currentPayload.model, token)
      return Promise.resolve(cfg.remediate({ error, payload: currentPayload, token, context }))
    },
  }
}
