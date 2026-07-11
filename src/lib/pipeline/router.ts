/**
 * v4 pipeline — route decision (S2), extracted from the FormatCodec into a free
 * function (ADR 2026-07-11-route-decision-separated-from-format-codec).
 *
 * `decideRoute` is the SINGLE place that reads upstream model capabilities
 * (`supported_endpoints` / vendor) to choose a protocol leg or reject — the concern
 * ADR pulls out of the codecs so a codec becomes a pure format translator. It unifies
 * the 5 previously-per-codec decisions (anthropic / openai-cc / openai-responses /
 * openai-gemini) behind one `clientFormat`-dispatched function.
 *
 * ── Phase 0 transition (large-refactor commit invariant) ──────────────────────────────
 * The migration is incremental: each `clientFormat` moves from its codec's still-live
 * `decideRoute` into this function one commit at a time (T0.1 anthropic, T0.2 cc, T0.3
 * responses incl. the Google force-fallback, T0.4 gemini). Until a format is migrated,
 * `decideRoute` delegates it to the `bridge` — the driver's thunk back to
 * `codec.decideRoute` — so EVERY commit keeps the full 4-format golden
 * (`tests/pipeline/router-golden.it.test.ts`) byte-equivalent. The `bridge` parameter is
 * removed in T0.5 once all five codec implementations are deleted.
 */

import type { Model } from "~/lib/models/client"

import { supportsDirectAnthropicApi } from "~/lib/anthropic/features"
import { ENDPOINT } from "~/lib/models/endpoint"

import type { RequestEnvelope } from "./envelope"
import type { RouteDecision } from "./types"

/**
 * Transition delegate to a not-yet-migrated codec's live `decideRoute` (Phase 0 T0.1–T0.4).
 * The driver supplies `(env) => deps.codec.decideRoute(env)`; the bridge shrinks as each
 * format migrates and is dropped in T0.5.
 */
export type RouteBridge = (env: RequestEnvelope) => RouteDecision

/**
 * S2 — passthrough / translate / reject, dispatched by `env.clientFormat`. The only reader
 * of upstream model capabilities. During the Phase 0 migration a format not yet moved here
 * delegates to `bridge` (see module docstring).
 */
export function decideRoute(env: RequestEnvelope, bridge: RouteBridge): RouteDecision {
  if (env.clientFormat === "anthropic") return decideAnthropicRoute(env)
  // Transition bridge (T0.1): openai-cc / openai-responses / gemini still resolve through
  // their live codec.decideRoute until T0.2 / T0.3 / T0.4 migrate them here.
  return bridge(env)
}

// ============================================================================
// anthropic (T0.1)
// ============================================================================

/**
 * anthropic /v1/messages is bypass-direct: passthrough `/v1/messages` or reject 400 — NO
 * translate/fallback (RFC §2.2 / messages:167). `id` falls back to the request body's model
 * when the index missed (`env.model` undefined).
 */
function decideAnthropicRoute(env: RequestEnvelope): RouteDecision {
  const id = (env.model as Model | undefined)?.id ?? (env.body as { model: string }).model
  const decision = supportsDirectAnthropicApi(id)
  if (!decision.supported) {
    return { kind: "reject", status: 400, reason: `Model "${id}" does not support /v1/messages: ${decision.reason}` }
  }
  return { kind: "passthrough", endpoint: ENDPOINT.MESSAGES }
}
