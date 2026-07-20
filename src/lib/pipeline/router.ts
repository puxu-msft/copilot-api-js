/**
 * v4 pipeline — route decision (S2), extracted from the FormatCodec into a free
 * function (ADR 2026-07-11-route-decision-separated-from-format-codec).
 *
 * `decideRoute` is the SINGLE place that reads upstream model capabilities
 * (`supported_endpoints` / vendor) to choose a protocol leg or reject — the concern
 * ADR pulls out of the codecs so a codec becomes a pure format translator. It unifies
 * the 5 previously-per-codec decisions (anthropic / openai-cc / openai-responses /
 * gemini) behind one `clientFormat`-dispatched function.
 *
 * Phase 1 (translation-matrix) turns this into the full-matrix decision tree
 * (RFC 2026-07-11-anthropic-via-openai-translation §4.3) via {@link RouteInput}: a
 * client can pin the outbound leg with a `@cc`/`@responses`/`@messages` suffix
 * (`env.routeOverride`, parsed by `resolveModelTarget`). The NO-SUFFIX path is left
 * byte-identical to Phase 0 (each inbound reduces to its original decideXxxRoute), so
 * `tests/pipeline/router-golden.it.test.ts` (the Phase 0 golden oracle) still passes
 * byte-for-byte. The SUFFIX path is purely additive (the golden exercises no suffix),
 * establishing the routing skeleton the later translation phases wire end-to-end.
 */

import type { Model } from "~/lib/models/client"
import type { RouteOverride } from "~/lib/models/normalize-id"

import { supportsDirectAnthropicApi } from "~/lib/anthropic/features"
import {
  //
  ENDPOINT,
  isEndpointSupported,
  isResponsesSupported,
} from "~/lib/models/endpoint"
import { shouldForceChatCompletionsFallback } from "~/routes/responses/fallback"

import type {
  //
  ClientFormat,
  RequestEnvelope,
  UpstreamEndpoint,
} from "./envelope"
import type { RouteDecision } from "./types"

/**
 * The narrow routing input the router reads (RFC §4.2) — the decoupled subset of the
 * envelope decideRoute actually needs, so the routing logic never depends on the full
 * envelope shape. `modelName` is the resolved id (`model?.id ?? body.model`) the
 * anthropic gate + reject reasons key on; `model` is the indexed capabilities (undefined
 * on an index miss — legacy-true defaults apply); `routeOverride` is the explicit leg pin.
 */
export interface RouteInput {
  clientFormat: ClientFormat
  modelName: string
  routeOverride?: RouteOverride
  model: Model | undefined
}

/** Extract the narrow {@link RouteInput} from the envelope (the router's only env read). */
function toRouteInput(env: RequestEnvelope): RouteInput {
  const model = env.model as Model | undefined
  const modelName = model?.id ?? (env.body as { model: string }).model
  return {
    clientFormat: env.clientFormat,
    modelName,
    ...(env.routeOverride && { routeOverride: env.routeOverride }),
    model,
  }
}

/**
 * S2 — passthrough / translate / reject. The only reader of upstream model
 * capabilities (`supported_endpoints` / vendor). Splits on whether the client pinned
 * an explicit outbound leg (`env.routeOverride`):
 *   - suffix present → {@link decideExplicitLeg} (the full-matrix gate — RFC §4.3).
 *   - no suffix      → the per-inbound default logic, BYTE-IDENTICAL to Phase 0.
 */
export function decideRoute(env: RequestEnvelope): RouteDecision {
  return decideRouteFromInput(toRouteInput(env))
}

/** {@link decideRoute} on the narrow input — the testable core (RFC §4.2/§4.3). */
export function decideRouteFromInput(input: RouteInput): RouteDecision {
  if (input.routeOverride) return decideExplicitLeg(input)

  // ── NO-SUFFIX: cc/responses/gemini reduce to Phase 0 per-inbound behavior (golden byte-identity);
  //    anthropic now forward-translates non-Anthropic models (Phase 7 no-suffix auto-route). ──
  switch (input.clientFormat) {
    case "anthropic": {
      return decideAnthropicRoute(input)
    }
    case "openai-cc": {
      return decideOpenAiCcRoute(input.model)
    }
    case "openai-responses": {
      return decideOpenAiResponsesRoute(input.model)
    }
    case "gemini": {
      // gemini has no endpoint gate of its own — its route mirrors the openai-cc decision
      // (RFC §4.3 W-priority "gemini: cc > responses"; the codec delegated to its internal
      // cc codec's decideRoute).
      return decideOpenAiCcRoute(input.model)
    }
    default: {
      // Exhaustive over ClientFormat — unreachable; a new inbound format must add its case above.
      throw new Error(`[router] unhandled clientFormat: ${String(input.clientFormat)}`)
    }
  }
}

// ============================================================================
// Explicit-leg routing (RFC §4.3, `@cc` / `@responses` / `@messages`)
// ============================================================================

/** The inbound format's DEFAULT outbound leg — a targetEndpoint == this default is `passthrough`, else `translate`. */
const DEFAULT_LEG: Record<ClientFormat, UpstreamEndpoint> = {
  anthropic: ENDPOINT.MESSAGES,
  "openai-cc": ENDPOINT.CHAT_COMPLETIONS,
  "openai-responses": ENDPOINT.RESPONSES,
  gemini: ENDPOINT.CHAT_COMPLETIONS,
}

/** The outbound leg a `@<route>` suffix names. */
const OVERRIDE_LEG: Record<RouteOverride, UpstreamEndpoint> = {
  cc: ENDPOINT.CHAT_COMPLETIONS,
  responses: ENDPOINT.RESPONSES,
  messages: ENDPOINT.MESSAGES,
}

/**
 * Route an explicit `@<route>` suffix (RFC §4.3 candidate-resolution + unified
 * force-fallback + strict gate):
 *
 *   1. leg = OVERRIDE_LEG[routeOverride].
 *   2. Unified force-fallback (FAIL-Google-2, "force-vendor 优先于显式后缀"): a `/responses`
 *      leg on a force-vendor model (Google's Copilot /responses is a broken leg — an
 *      operational reality) is retargeted to `/chat/completions` — EVEN over an explicit
 *      `@responses`. This is the unified interception the RFC pulls out of the per-inbound
 *      logic; it is applied only on the explicit-suffix path here so the NO-SUFFIX cc/gemini
 *      translate-to-`/responses` legs stay byte-identical to Phase 0 (the golden), where
 *      force-fallback fires only for the responses-inbound default. Making it universal for
 *      the no-suffix cc/gemini legs is a deferred behavior change (would flip the golden's
 *      `google-resp` cc/gemini cells `/responses`→CC).
 *   3. Strict gate (FAIL-3): the model must actually support the (post-force) leg, else
 *      reject 400 — an explicit pin to an unsupported leg is an error, never a silent reroute.
 *      W4 legacy-true: a model with no `supported_endpoints` passes the CC/messages gate
 *      (legacy universal-fallback default), matching `isEndpointSupported`.
 *   4. kind = leg == the inbound's DEFAULT leg ? passthrough : translate.
 */
function decideExplicitLeg(input: RouteInput): RouteDecision {
  const routeOverride = input.routeOverride
  if (!routeOverride) return decideRouteFromInput(input) // unreachable (caller gated); keeps the type narrow

  let leg = OVERRIDE_LEG[routeOverride]

  // Unified force-fallback: force-vendor's /responses → /chat/completions (overrides @responses).
  // The retarget to CC is EXEMPT from the CC-support gate below — exactly as
  // `decideOpenAiResponsesRoute` treats the force list (`forceFallback || isEndpointSupported(CC)`):
  // Copilot's endpoint metadata for those SKUs is unreliable, so a Google model that advertises
  // ONLY /responses (google-resp) must still translate to CC, never reject.
  let forcedToCc = false
  if (leg === ENDPOINT.RESPONSES && shouldForceChatCompletionsFallback(input.model)) {
    leg = ENDPOINT.CHAT_COMPLETIONS
    forcedToCc = true
  }

  if (!forcedToCc && !isLegSupported(input, leg)) {
    return { kind: "reject", status: 400, reason: explicitRejectReason(input.modelName, routeOverride, leg) }
  }

  const kind = leg === DEFAULT_LEG[input.clientFormat] ? "passthrough" : "translate"
  return kind === "passthrough" ? { kind: "passthrough", endpoint: leg } : { kind: "translate", to: leg }
}

/**
 * The support check for an explicit leg — the semantically-correct gate PER LEG (each
 * mirrors how that leg's support is checked elsewhere), which is a deliberate refinement
 * over RFC §4.3's literal `isEndpointSupported(model, leg)` pseudocode:
 *   - `/chat/completions` → `isEndpointSupported` (legacy-true default).
 *   - `/responses`        → `isResponsesSupported` (covers the `ws:/responses` transport too).
 *   - `/v1/messages`      → `supportsDirectAnthropicApi` (the real direct-Anthropic gate:
 *     Anthropic vendor + messages support), NOT a bare `isEndpointSupported` — an OpenAI
 *     model that happens to list `/v1/messages` cannot serve an Anthropic-wire request.
 */
function isLegSupported(input: RouteInput, leg: UpstreamEndpoint): boolean {
  switch (leg) {
    case ENDPOINT.MESSAGES: {
      return supportsDirectAnthropicApi(input.modelName).supported
    }
    case ENDPOINT.RESPONSES:
    case ENDPOINT.WS_RESPONSES: {
      return isResponsesSupported(input.model)
    }
    default: {
      return isEndpointSupported(input.model, leg)
    }
  }
}

/** Descriptive 400 reason for an explicit-leg pin the model cannot serve (suffix path only; not golden-frozen). */
function explicitRejectReason(modelName: string, routeOverride: RouteOverride, leg: UpstreamEndpoint): string {
  if (leg === ENDPOINT.MESSAGES) {
    return `Model "${modelName}" does not support /v1/messages: ${supportsDirectAnthropicApi(modelName).reason}`
  }
  return `Model "${modelName}" pinned to @${routeOverride} but does not support the ${leg} endpoint`
}

// ============================================================================
// anthropic (no-suffix — Phase 0, unchanged)
// ============================================================================

/**
 * anthropic NO-SUFFIX routing (RFC §4.3 W-priority, user-adjusted order `messages > responses > cc`).
 *
 *   1. direct `/v1/messages` if the model is Anthropic-vendor + messages-capable (`supportsDirectAnthropicApi`).
 *   2. else FORWARD-translate to the first reachable OpenAI leg — **RESPONSES before CHAT_COMPLETIONS**.
 *      This is the user-decided order (2026-07-13), a DELIBERATE DEVIATION from the RFC §4.3 pseudocode's
 *      `messages > cc > responses`: gpt-5.x SKUs are Responses-first, so the convenience auto-route should
 *      prefer /responses. A /responses candidate on a force-fallback vendor (Google's broken Copilot
 *      /responses) retargets to /chat/completions, mirroring {@link decideExplicitLeg}.
 *   3. else reject 400 (no direct + no translatable OpenAI leg).
 *
 * `modelName` (resolved id, or the body's model on an index miss) keys the direct gate + reject reason;
 * `model` (indexed capabilities) keys the forward-leg support checks. This is the no-suffix convenience the
 * headline use case needs ("Claude Code uses a gpt model" → the proxy forward-translates it); the explicit
 * `@cc`/`@responses` suffix still lets the client pin a leg. It was reject-only through Phase 0-6 (the
 * translation machinery landed but the no-suffix auto-route was deferred and never wired) — Phase 7
 * completes it (`isResponsesSupported` shares the explicit-leg gate at {@link isLegSupported}, so no-suffix
 * and `@responses` agree on which models are responses-capable, incl. the legacy-true default).
 */
function decideAnthropicRoute(input: RouteInput): RouteDecision {
  const direct = supportsDirectAnthropicApi(input.modelName)
  if (direct.supported) return { kind: "passthrough", endpoint: ENDPOINT.MESSAGES }

  // Forward-translate candidate leg — responses > cc (user-adjusted priority).
  let leg: UpstreamEndpoint | undefined
  if (isResponsesSupported(input.model)) leg = ENDPOINT.RESPONSES
  else if (isEndpointSupported(input.model, ENDPOINT.CHAT_COMPLETIONS)) leg = ENDPOINT.CHAT_COMPLETIONS

  if (leg === undefined) {
    return {
      kind: "reject",
      status: 400,
      reason: `Model "${input.modelName}" cannot be served on /v1/messages (${direct.reason}) and supports no translatable /responses or /chat/completions leg`,
    }
  }

  // Google force-fallback: a /responses candidate on a force-vendor model retargets to /chat/completions
  // (Copilot's Google /responses is broken — mirrors the explicit-leg unified interception).
  if (leg === ENDPOINT.RESPONSES && shouldForceChatCompletionsFallback(input.model)) {
    leg = ENDPOINT.CHAT_COMPLETIONS
  }

  // A non-Anthropic model's forward leg is never the anthropic default (/v1/messages) → always translate.
  return { kind: "translate", to: leg }
}

// ============================================================================
// openai-cc (no-suffix — Phase 0, unchanged)
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
// openai-responses (no-suffix — Phase 0, unchanged)
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
 * The Google force-fallback stays embedded HERE (not the unified explicit-leg interception)
 * so the no-suffix golden reduces byte-identically.
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
