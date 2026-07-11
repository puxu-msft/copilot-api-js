/**
 * v4 pipeline — route decision (S2), extracted from the FormatCodec into a free
 * function (ADR 2026-07-11-route-decision-separated-from-format-codec).
 *
 * `decideRoute` is the SINGLE place that reads upstream model capabilities
 * (`supported_endpoints` / vendor) to choose a protocol leg or reject — the concern
 * ADR pulls out of the codecs so a codec becomes a pure format translator. It unifies
 * the 5 previously-per-codec decisions (anthropic / openai-cc / openai-responses /
 * openai-gemini) behind one `clientFormat`-dispatched function. Route-decision behavior is
 * frozen byte-for-byte by `tests/pipeline/router-golden.it.test.ts` (Phase 0 golden oracle).
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
 * S2 — passthrough / translate / reject, dispatched by `env.clientFormat`. The only reader
 * of upstream model capabilities (`supported_endpoints` / vendor).
 */
export function decideRoute(env: RequestEnvelope): RouteDecision {
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
