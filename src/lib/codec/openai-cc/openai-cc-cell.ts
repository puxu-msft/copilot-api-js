/**
 * The `/chat/completions` OUTBOUND leg (Chat Completions wire) for the CellAssembly refactor (RFC
 * 2026-07-13 §11). Fills `OUTBOUND_LEGS[ENDPOINT.CHAT_COMPLETIONS]`.
 *
 * Four cells share this leg, dispatched by clientFormat:
 *   - `openai-cc` (DIRECT `/chat/completions`) — native CC, `translateOut` identity.
 *   - `anthropic` / `gemini` (FORWARD `@cc`) — the hub translates source→CC in `translateOut`.
 *   - `openai-responses` (FALLBACK `/chat`) — the Responses→CC fallback: `translateOut` builds the
 *     per-request fallback exchange (via the shared `requestState.responsesFallbackScratch`), `prepareWire`
 *     runs the Responses→CC translation + prior-conversation prepend. R1/HIGH-A corner: its retry stack is
 *     the Responses stack (auto-truncate OFF, maxRetries 1) — the other three run the CC stack.
 *
 * The CC cells reuse the `openai-cc-leg` cores; the fallback cell reuses the `openai-responses-leg` cores
 * (+ the shared `openai-responses-cell` scratch). Byte-for-byte identical to the codecs/handlers (the CC
 * http golden + the responses-fallback tests lock it).
 */

import type { Model } from "~/lib/models/client"
import type {
  //
  OutboundLeg,
  RetrySemanticsSpec,
} from "~/lib/pipeline/cell-assembly"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  RequestRewrite,
  ResponseRewrite,
} from "~/lib/pipeline/rewrite-registry"
import type {
  //
  PreparedRequest,
  RequestSample,
  RetryStrategy,
} from "~/lib/pipeline/types"

import { ALL_RESPONSE_REWRITES } from "~/lib/codec/response-rewrite-registry"
import { ENDPOINT } from "~/lib/models/endpoint"
import { translateRequestVia } from "~/lib/pipeline/hub-translate"
import { state } from "~/lib/state"

import { buildCcFamilyLegStrategies } from "../cc-family-strategies"
import {
  //
  type ResponsesFallbackScratch,
  prepareResponsesFallbackWire,
  sampleResponsesFallbackWireTrack,
} from "../openai-responses/openai-responses-leg"
import {
  //
  prepareChatCompletionsWire,
  sampleChatCompletionsWireTrack,
} from "./openai-cc-leg"

/** Is this the openai-responses FALLBACK `/chat` cell (Responses→CC wire), vs a CC-shaped direct/forward cell? */
function isResponsesFallback(env: RequestEnvelope): boolean {
  return env.clientFormat === "openai-responses"
}

/** Is this a FORWARD `@cc` cell (anthropic/gemini client translated to the CC wire)? */
function isForward(env: RequestEnvelope): boolean {
  return env.clientFormat === "anthropic" || env.clientFormat === "gemini"
}

/** The shared fallback-exchange scratch parse put on requestState (the CHAT fallback cell reads it). */
function fallbackScratch(env: RequestEnvelope): ResponsesFallbackScratch {
  const scratch = env.requestState?.responsesFallbackScratch as ResponsesFallbackScratch | undefined
  if (!scratch) throw new Error("[openai-cc-cell] env.requestState.responsesFallbackScratch missing — openai-responses parse did not populate the fallback leg supply")
  return scratch
}

/** The `/chat/completions` outbound leg — openai-cc DIRECT + anthropic/gemini FORWARD `@cc` + openai-responses FALLBACK. */
export const chatCompletionsLeg: OutboundLeg = {
  targetEndpoint: ENDPOINT.CHAT_COMPLETIONS,

  // S2: openai-cc DIRECT is identity (native CC). openai-responses FALLBACK is identity (the Responses→CC
  // translation is in prepareWire) but ALSO builds the per-request fallback exchange (ids + rebuilt prior
  // conversation) into the shared scratch — the codec render side reads the SAME instance. anthropic/gemini
  // FORWARD translate source→CC via the hub → env.body becomes CC-shaped.
  translateOut(env) {
    if (isResponsesFallback(env)) {
      // Observability: the Responses→CC fallback feature (parity with the responses/ws handlers' strategies
      // factory). Recorded once per request (S2), before the exchange.
      env.ctx.recordFeature("via-chat-completions-fallback")
      fallbackScratch(env).ensure(env)
      return env
    }
    if (!isForward(env)) return env
    const ccBody = translateRequestVia(env.clientFormat, env.targetEndpoint, env.body, { model: env.model as Model | undefined })
    return env.with({ body: ccBody })
  },

  // S3: no request rewrite (the reverse-sanitize dep is MESSAGES-gated, inert on /chat; BUILTIN empty).
  requestRewrites(): ReadonlyArray<RequestRewrite> {
    return []
  },

  prepareWire(env): PreparedRequest {
    // FALLBACK: Responses→CC wire (prior-conversation prepend from the scratch's exchange). Others: CC wire.
    if (isResponsesFallback(env)) return prepareResponsesFallbackWire(env, fallbackScratch(env).exchange?.rebuiltMessages)
    return prepareChatCompletionsWire(env)
  },

  responseRewrites(): ReadonlyArray<ResponseRewrite> {
    // The driver's assembleResponseRewrites filters this full union to the /chat subset via each
    // rewrite's appliesTo — the same array the handlers passed as deps.responseRewrites.
    return ALL_RESPONSE_REWRITES
  },

  // No preSend: neither the CC nor the Responses-fallback stack has an Anthropic pre-flight truncation.

  sampleWireTrack(wire, env): RequestSample {
    // FALLBACK: Responses effective + CC wire. Others: CC effective + CC wire.
    return isResponsesFallback(env) ? sampleResponsesFallbackWireTrack(wire, env) : sampleChatCompletionsWireTrack(wire, env)
  },

  buildLegStrategies(spec: RetrySemanticsSpec, env): ReadonlyArray<RetryStrategy> {
    // R1/HIGH-A: spec.autoTruncate (false for the openai-responses FALLBACK cell, true for the CC-family
    // direct/forward cells) selects the Responses vs CC stack. anthropic FORWARD uses env.body as the CC
    // baseline; openai-cc/gemini use requestState.truncateBaseline (both inside buildCcFamilyLegStrategies).
    return buildCcFamilyLegStrategies(spec, env)
  },
}

/**
 * RETRY_SEMANTICS for a CC-shaped cell served by the `/chat/completions` leg: the CC stack (auto-truncate
 * ON, N retries) for openai-cc DIRECT + anthropic/gemini FORWARD `@cc`. The only per-cell difference is the
 * console `label`. (The openai-responses FALLBACK cell's semantics come from `responsesFallbackRetrySemantics`.)
 */
export function chatCompletionsRetrySemantics(label: string): RetrySemanticsSpec {
  return { maxRetries: state.maxReactiveRetries, label }
}

/**
 * RETRY_SEMANTICS for the openai-responses FALLBACK `/chat` cell — the R1/HIGH-A corner: auto-truncate OFF,
 * maxRetries 1 (the Responses stack against the pre-translation Responses body, matching the legacy handler's
 * `buildOpenAiResponsesStrategiesForEnv`), unlike the CC-shaped cells on the same leg which are ON.
 */
export function responsesFallbackRetrySemantics(): RetrySemanticsSpec {
  return { maxRetries: 1, label: "Responses(→CC fallback)" }
}
