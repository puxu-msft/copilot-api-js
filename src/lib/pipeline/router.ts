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
import {
  //
  ENDPOINT,
  isEndpointSupported,
  isResponsesSupported,
} from "~/lib/models/endpoint"
import { shouldForceChatCompletionsFallback } from "~/routes/responses/fallback"

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
  switch (env.clientFormat) {
    case "anthropic": {
      return decideAnthropicRoute(env)
    }
    case "openai-cc": {
      return decideOpenAiCcRoute(env.model as Model | undefined)
    }
    case "openai-responses": {
      return decideOpenAiResponsesRoute(env.model as Model | undefined)
    }
    case "gemini": {
      // gemini has no endpoint gate of its own — its route mirrors the openai-cc decision
      // (the codec delegated to its internal cc codec's decideRoute; RFC §4.3 W-priority
      // "gemini: cc > responses").
      return decideOpenAiCcRoute(env.model as Model | undefined)
    }
    default: {
      // All 4 ClientFormats are migrated (T0.1–T0.4); this bridge is now an unreachable
      // defensive fallback. The `bridge` param + this case are removed in T0.5 together with
      // the FormatCodec.decideRoute interface method.
      return bridge(env)
    }
  }
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

// ============================================================================
// openai-cc (T0.2)
// ============================================================================

/**
 * openai-cc: passthrough `/chat/completions` / translate `/responses` (via) / reject 400
 * (docs/v4/03-spec/codec.md §2).
 *   - `isEndpointSupported(/chat/completions)` → passthrough
 *   - elif `isResponsesSupported`             → translate `/responses`
 *   - else                                    → reject 400
 *
 * Non-uniform default (preserved): `isEndpointSupported` treats a model with no
 * `supported_endpoints` as supporting everything (legacy fallback) — so unknown gpt-* models
 * passthrough to /chat/completions.
 */
function decideOpenAiCcRoute(model: Model | undefined): RouteDecision {
  if (isEndpointSupported(model, ENDPOINT.CHAT_COMPLETIONS)) {
    return { kind: "passthrough", endpoint: ENDPOINT.CHAT_COMPLETIONS }
  }
  if (isResponsesSupported(model)) {
    return { kind: "translate", to: ENDPOINT.RESPONSES }
  }
  const id = model?.id ?? "unknown"
  return { kind: "reject", status: 400, reason: `Model "${id}" does not support the ${ENDPOINT.CHAT_COMPLETIONS} endpoint` }
}

// ============================================================================
// openai-responses (T0.3)
// ============================================================================

/**
 * openai-responses: passthrough `/responses` / translate `/chat/completions` (fallback) /
 * reject 400. Mirrors the legacy `handleResponses` dispatch:
 *   useFallback = !isResponsesSupported(model) || forceFallback(Google)
 *   !useFallback                                   → passthrough /responses
 *   useFallback ∧ (isEndpointSupported(CC) ∨ force) → translate /chat/completions
 *   else                                           → reject 400
 *
 * Non-uniform defaults (preserved): `isResponsesSupported` absent → false (do not implicitly
 * enable); the Google force-list is exempt from the CC support check (Copilot's endpoint
 * metadata for those SKUs is unreliable, so force-fallback to CC even without advertised CC).
 */
function decideOpenAiResponsesRoute(model: Model | undefined): RouteDecision {
  const forceFallback = shouldForceChatCompletionsFallback(model)
  const useFallback = !isResponsesSupported(model) || forceFallback
  if (!useFallback) {
    return { kind: "passthrough", endpoint: ENDPOINT.RESPONSES }
  }
  if (forceFallback || isEndpointSupported(model, ENDPOINT.CHAT_COMPLETIONS)) {
    return { kind: "translate", to: ENDPOINT.CHAT_COMPLETIONS }
  }
  const id = model?.id ?? "unknown"
  return { kind: "reject", status: 400, reason: `Model "${id}" does not support /responses or /chat/completions` }
}
