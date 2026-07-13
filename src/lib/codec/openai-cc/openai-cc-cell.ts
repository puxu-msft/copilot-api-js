/**
 * The `/chat/completions` OUTBOUND leg (Chat Completions wire) for the CellAssembly refactor (RFC
 * 2026-07-13 §11). Fills `OUTBOUND_LEGS[ENDPOINT.CHAT_COMPLETIONS]`.
 *
 * Three cells share this leg (all reach it with a CC-shaped `env.body`):
 *   - `openai-cc` (DIRECT `/chat/completions`) — native CC, `translateOut` identity.
 *   - `anthropic` (FORWARD `@cc`) — the hub translates Anthropic→CC in `translateOut`.
 *   - `gemini` (FORWARD `@cc`) — the hub translates Gemini→CC in `translateOut`.
 *
 * All three reuse the SAME `openai-cc-leg` wire cores + `buildOpenAiCcStrategies` the codecs/handlers
 * call today, so the driver's cell-keyed fork is byte-for-byte identical (the CC http golden locks it).
 * Request-lifecycle-stable supply (the auto-truncate baseline) is read from `env.requestState`.
 *
 * The `(openai-responses, /chat)` FALLBACK cell is NOT served here — its wire is the openai-responses
 * codec's Responses→CC translation with prior-conversation prepend + a per-request fallback exchange
 * (responseId/itemId/rebuiltMessages), and its strategies are the Responses stack (no auto-truncate);
 * it lands in C4 alongside the Responses leg + the exchange-scratch carrier (RFC §11.2c).
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
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { ALL_RESPONSE_REWRITES } from "~/lib/codec/response-rewrite-registry"
import { ENDPOINT } from "~/lib/models/endpoint"
import { translateRequestVia } from "~/lib/pipeline/hub-translate"
import { state } from "~/lib/state"

import { buildOpenAiCcStrategies } from "./strategies"
import {
  //
  prepareChatCompletionsWire,
  sampleChatCompletionsWireTrack,
} from "./openai-cc-leg"

/** Is this a FORWARD `@cc` cell (a non-CC client translated to the CC wire)? */
function isForward(env: RequestEnvelope): boolean {
  return env.clientFormat !== "openai-cc"
}

/** The `/chat/completions` outbound leg — openai-cc DIRECT + anthropic/gemini FORWARD `@cc` (C3). */
export const chatCompletionsLeg: OutboundLeg = {
  targetEndpoint: ENDPOINT.CHAT_COMPLETIONS,

  // S2: openai-cc DIRECT is identity (native CC). A FORWARD leg (anthropic/gemini client) translates
  // source→CC via the hub → env.body becomes CC-shaped from here on.
  translateOut(env) {
    if (!isForward(env)) return env
    const ccBody = translateRequestVia(env.clientFormat, env.targetEndpoint, env.body, { model: env.model as Model | undefined })
    return env.with({ body: ccBody })
  },

  // S3: no CC-leg request rewrite. The handlers pass a reverse Anthropic sanitize rewrite gated on
  // `/v1/messages` (inert on `/chat`), so the legacy path already assembled an empty chain here.
  requestRewrites(): ReadonlyArray<RequestRewrite> {
    return []
  },

  prepareWire(env): PreparedRequest {
    return prepareChatCompletionsWire(env)
  },

  responseRewrites(): ReadonlyArray<ResponseRewrite> {
    // The driver's assembleResponseRewrites filters this full union to the /chat subset via each
    // rewrite's appliesTo — the same array the handlers passed as deps.responseRewrites.
    return ALL_RESPONSE_REWRITES
  },

  // No preSend: CC has no pre-flight truncation (the pre-flight hook is Anthropic-only).

  sampleWireTrack(wire, env): RequestSample {
    return sampleChatCompletionsWireTrack(wire, env)
  },

  buildLegStrategies(spec: RetrySemanticsSpec, env): ReadonlyArray<RetryStrategy> {
    // anthropic FORWARD `@cc` uses env.body (the hub-translated CC body) as the auto-truncate baseline —
    // matching the messages handler's `originalPayload: env.body`. openai-cc DIRECT + gemini FORWARD use
    // the parse-captured `truncateBaseline` (the un-sanitized, post-tool-rename CC payload) — matching the
    // cc/gemini handlers' `codec.getTruncateBaseline() ?? env.body`.
    const originalPayload =
      env.clientFormat === "anthropic" ?
        (env.body as ChatCompletionsPayload)
      : ((env.requestState?.truncateBaseline as ChatCompletionsPayload | undefined) ?? (env.body as ChatCompletionsPayload))
    return buildOpenAiCcStrategies({
      originalPayload,
      model: env.model as Model | undefined,
      maxRetries: spec.maxRetries,
      label: spec.label,
    })
  },
}

/**
 * RETRY_SEMANTICS for a cell served by the `/chat/completions` leg: the CC strategy stack (auto-truncate
 * ON, N retries) for all three C3 cells (openai-cc DIRECT + anthropic/gemini FORWARD `@cc`). The only
 * per-cell difference is the console `label` — the wire + strategy shape are identical (all CC-shaped
 * bodies). `maxRetries` is `autoTruncateMaxRetries` (the CC handlers' value).
 */
export function chatCompletionsRetrySemantics(label: string): RetrySemanticsSpec {
  return { autoTruncate: true, maxRetries: state.autoTruncateMaxRetries, label }
}
