/**
 * The `/responses` (+ its `ws:` transport) OUTBOUND leg + the openai-responses client's `/chat/completions`
 * FALLBACK wire — algorithm cores extracted VERBATIM from the openai-cc + openai-responses codecs (C4 of
 * the CellAssembly refactor, RFC 2026-07-13 §11). Already pure over `env` (+ the prepared wire), so the
 * extraction is byte-for-byte identical (the C0 ws golden + responses http goldens lock it).
 *
 * Three wire shapes reach the RESPONSES leg / the responses-fallback CHAT leg, dispatched by clientFormat:
 *   - `prepareResponsesDirectWire` — `(openai-responses, /responses)` DIRECT AND `(anthropic, /responses)`
 *     FORWARD (RFC 2026-07-14-anthropic-responses-direct-bridge §3): both reach `prepareWire` with an
 *     ALREADY Responses-shaped `env.body` (openai-responses via translateOut identity; anthropic via the
 *     hub's direct anthropic→responses bridge) → `prepareResponsesRequest`. R1/HIGH-A corner: the
 *     openai-responses cell's retry stack is the Responses stack (no auto-truncate, maxRetries 1) —
 *     encoded in RETRY_SEMANTICS, not here; the anthropic cell's retry stack is ALSO the Responses stack
 *     (`cc-family-strategies.ts`'s `isAnthropicDirectResponsesLeg`), but at `maxReactiveRetries` (not 1).
 *   - `prepareViaResponsesWire` — `(openai-cc|gemini, /responses)` via-responses/FORWARD: a
 *     CC-shaped env.body → CC→Responses translation (+ dropped-params warning + normalizeCallIds) →
 *     `prepareResponsesRequest`. The auto-truncate baseline stays CC-shaped (translation deferred to wire).
 *   - `prepareResponsesFallbackWire` — `(openai-responses, /chat)` FALLBACK: a Responses-shaped env.body →
 *     Responses→CC translation + prior-conversation prepend → `prepareChatCompletionsRequest` (NO O10 fill).
 *
 * Both the codecs (transitionally, until C4's driver fork routes these cells through the assembly) and the
 * assembly call the SAME cores — zero byte divergence.
 */

import consola from "consola"

import type { RequestContext } from "~/lib/context/request"
import type {
  //
  EffectiveRequest,
  WireRequest,
} from "~/lib/context/types"
import type { EndpointType } from "~/lib/history/store"
import type { Model } from "~/lib/models/client"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  PreparedRequest,
  RequestSample,
} from "~/lib/pipeline/types"
import type {
  //
  ChatCompletionsPayload,
  Message,
} from "~/types/api/openai-chat-completions"
import type {
  //
  ResponsesInputItem,
  ResponsesPayload,
} from "~/types/api/openai-responses"

import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  fillMaxCompletionTokens,
  prepareChatCompletionsRequest,
  prepareResponsesRequest,
} from "~/lib/openai/request-preparation"
import {
  //
  extractInputItems,
  normalizeCallIds,
} from "~/lib/openai/responses-conversion"
import {
  //
  translateChatCompletionsToResponses,
  translateResponsesToChatCompletions,
} from "~/lib/openai/translate"
import { state } from "~/lib/state"

const RESPONSES_ENDPOINT_TYPE: EndpointType = "openai-responses"
/** History `format` label for the CC track (the via-responses effective + the fallback wire). */
const CC_ENDPOINT_TYPE: EndpointType = "openai-chat-completions"
const DROPPED_CC_PARAMS_WARNING_CODE = "cc_to_responses_dropped_params"

// ============================================================================
// Fallback exchange scratch (RFC §11.2c) — shared by the codec render side + the CHAT leg
// ============================================================================

/** The per-request fallback-exchange (stable IDs + rebuilt prior conversation). */
export interface FallbackExchange {
  responseId: string
  itemId: string
  /** Model name for the CC→Responses translator's `response.created.model` (resolved name). */
  clientModel: string
  /** Prior conversation rebuilt from session history, prepended to the translated CC payload. */
  rebuiltMessages: Array<Message>
}

/**
 * The shared MUTABLE fallback-exchange scratch (RFC §11.2c) both the openai-responses InboundCodec (render
 * side — reads `exchange` ids) and the CHAT fallback leg (`translateOut` calls `ensure`, `prepareWire` reads
 * `exchange.rebuiltMessages`) reference — the SAME per-request instance the codec's parse threads onto
 * `env.requestState.responsesFallbackScratch`. `ensure` builds the exchange LAZILY + idempotently (the codec
 * owns the build closure — resolvedModelName / genShortId / rebuildConversationMessages).
 */
export interface ResponsesFallbackScratch {
  exchange: FallbackExchange | undefined
  ensure(env: RequestEnvelope): FallbackExchange
}

// ============================================================================
// prepareWire — the three RESPONSES-family wire shapes
// ============================================================================

/**
 * `(openai-responses, /responses)` DIRECT wire: env.body is Responses-shaped → `prepareResponsesRequest`.
 * Extracted VERBATIM from the openai-responses codec's `prepareOpenAiResponsesWire` RESPONSES branch (C4).
 */
export function prepareResponsesDirectWire(env: RequestEnvelope): PreparedRequest {
  const model = env.model as Model | undefined
  const prepared = prepareResponsesRequest(env.body as ResponsesPayload, { resolvedModel: model })
  return {
    url: ENDPOINT.RESPONSES,
    headers: new Headers(prepared.headers),
    body: prepared.wire,
    stream: prepared.wire.stream ?? false,
  }
}

/**
 * `(openai-cc|gemini, /responses)` via-responses wire: env.body is CC-shaped → O10 fill →
 * CC→Responses translation (+ dropped-params warning, deduped on ctx) → optional normalizeCallIds →
 * `prepareResponsesRequest`. Extracted VERBATIM from the openai-cc codec's `prepareOpenAiCcWire` RESPONSES
 * branch (C4). Idempotent (pure function of env.body + model + the once-recorded ctx warning).
 *
 * `(anthropic, /responses)` FORWARD does NOT reach this function — its body is ALREADY Responses-shaped
 * (RFC 2026-07-14-anthropic-responses-direct-bridge §2.3/§3 direct bridge — the hub's `translateOut`
 * produces a Responses body directly, skipping CC), so `openai-responses-cell.ts`'s `bodyIsResponsesShaped`
 * routes it through `prepareResponsesDirectWire` instead (the SAME core the openai-responses DIRECT cell
 * uses — a CC→Responses re-translation here would be a double-translation / garbage request, and was
 * previously a byte-identical duplicate branch bolted onto this via-responses path — cleanup post-subtask-A).
 */
export function prepareViaResponsesWire(env: RequestEnvelope): PreparedRequest {
  const model = env.model as Model | undefined
  const ccPayload = fillMaxCompletionTokens(env.body as ChatCompletionsPayload, model)
  const { payload: responsesPayload, droppedParams } = translateChatCompletionsToResponses(ccPayload)
  if (droppedParams.length > 0) recordDroppedCcParamsWarning(env.ctx, ccPayload.model, droppedParams)
  const finalResponses = state.normalizeResponsesCallIds ? normalizeCallIds(responsesPayload) : responsesPayload
  const prepared = prepareResponsesRequest(finalResponses, { resolvedModel: model })
  return {
    url: ENDPOINT.RESPONSES,
    headers: new Headers(prepared.headers),
    body: prepared.wire,
    stream: prepared.wire.stream ?? false,
  }
}

/**
 * `(openai-responses, /chat)` FALLBACK wire: env.body is Responses-shaped → Responses→CC translation +
 * prior-conversation prepend (after the system/developer prelude, before the current turn) →
 * `prepareChatCompletionsRequest` (NO O10 fill — matches the legacy fallback's `createChatCompletions`).
 * Extracted VERBATIM from the openai-responses codec's `prepareOpenAiResponsesWire` CHAT branch (C4).
 * `rebuiltMessages` is the per-request fallback exchange's rebuilt prior conversation (empty for none).
 */
export function prepareResponsesFallbackWire(env: RequestEnvelope, rebuiltMessages: ReadonlyArray<Message> | undefined): PreparedRequest {
  const model = env.model as Model | undefined
  const ccPayload = translateResponsesToChatCompletions(env.body as ResponsesPayload)
  const rebuilt = rebuiltMessages ?? []
  if (rebuilt.length > 0) {
    const prelude = ccPayload.messages.filter((m) => m.role === "system" || m.role === "developer")
    const current = ccPayload.messages.filter((m) => m.role !== "system" && m.role !== "developer")
    ccPayload.messages = [...prelude, ...rebuilt, ...current]
  }
  const prepared = prepareChatCompletionsRequest(ccPayload, { resolvedModel: model })
  return {
    url: ENDPOINT.CHAT_COMPLETIONS,
    headers: new Headers(prepared.headers),
    body: prepared.wire,
    stream: prepared.wire.stream ?? false,
  }
}

/**
 * Record the "CC→Responses dropped unsupported params" warning on the context, deduped by code+message
 * (prepareWire runs per-attempt; without the dedup each retry would re-warn). Extracted VERBATIM from the
 * openai-cc codec (C4).
 */
function recordDroppedCcParamsWarning(ctx: RequestContext, model: string, droppedParams: Array<string>): void {
  const message = `Chat Completions -> Responses translation dropped unsupported params: ${droppedParams.join(", ")}`
  const alreadyRecorded = ctx.warningMessages.some((w) => w.code === DROPPED_CC_PARAMS_WARNING_CODE && w.message === message)
  if (alreadyRecorded) return

  consola.warn(`[CC→Responses] model=${model} ${message}`)
  ctx.addWarningMessage({ code: DROPPED_CC_PARAMS_WARNING_CODE, message })
  ctx.recordFeature("dropped-params")
}

// ============================================================================
// sampleWireTrack — the two-track observability per (clientFormat × leg)
// ============================================================================

/**
 * `(openai-responses, /responses)` DIRECT sampler: effective = Responses-shaped env.body (`messages` is
 * `[]` — a Responses payload has `input`), wire = Responses `input` items. Both `openai-responses`.
 * Extracted VERBATIM from the openai-responses codec's `sampleOpenAiResponsesRequest` direct branch (C4).
 */
export function sampleResponsesDirectWireTrack(wire: PreparedRequest, env: RequestEnvelope): RequestSample {
  const effBody = env.body as { model?: unknown; messages?: unknown }
  const effective: EffectiveRequest = {
    model: typeof effBody.model === "string" ? effBody.model : "",
    resolvedModel: env.model as Model | undefined,
    messages: Array.isArray(effBody.messages) ? effBody.messages : [],
    payload: env.body,
    format: RESPONSES_ENDPOINT_TYPE,
  }

  const wireBody = wire.body as { model?: unknown; input?: string | Array<ResponsesInputItem> }
  const wireRequest: WireRequest = {
    model: typeof wireBody.model === "string" ? wireBody.model : "",
    messages: extractInputItems(wireBody.input ?? []),
    payload: wire.body,
    headers: Object.fromEntries(wire.headers.entries()),
    format: RESPONSES_ENDPOINT_TYPE,
  }

  return { effective, wire: wireRequest }
}

/**
 * `(openai-cc|gemini, /responses)` via-responses sampler: effective = CC-shaped env.body
 * (`openai-chat-completions`), wire = Responses `input` items (`openai-responses`). Extracted VERBATIM
 * from the openai-cc codec's `sampleOpenAiCcRequest` RESPONSES branch (C4).
 *
 * `(anthropic, /responses)` FORWARD does NOT reach this function — its body is ALREADY Responses-shaped
 * (the direct bridge, RFC 2026-07-14 §2.3/§3), so `openai-responses-cell.ts`'s `bodyIsResponsesShaped`
 * samples it via `sampleResponsesDirectWireTrack` instead (cleanup post-subtask-A: this file previously
 * carried a byte-identical anthropic-only branch duplicating that sampler).
 */
export function sampleViaResponsesWireTrack(wire: PreparedRequest, env: RequestEnvelope): RequestSample {
  const effBody = env.body as { model?: unknown; messages?: unknown }
  const effective: EffectiveRequest = {
    model: typeof effBody.model === "string" ? effBody.model : "",
    resolvedModel: env.model as Model | undefined,
    messages: Array.isArray(effBody.messages) ? effBody.messages : [],
    payload: env.body,
    format: CC_ENDPOINT_TYPE,
  }

  const wireBody = wire.body as { model?: unknown; input?: string | Array<ResponsesInputItem> }
  const wireRequest: WireRequest = {
    model: typeof wireBody.model === "string" ? wireBody.model : "",
    messages: extractInputItems(wireBody.input ?? []),
    payload: wire.body,
    headers: Object.fromEntries(wire.headers.entries()),
    format: RESPONSES_ENDPOINT_TYPE,
  }

  return { effective, wire: wireRequest }
}

/**
 * `(openai-responses, /chat)` FALLBACK sampler: effective = Responses-shaped env.body (`openai-responses`,
 * `messages` = `[]`), wire = CC `messages` (`openai-chat-completions`). Extracted VERBATIM from the
 * openai-responses codec's `sampleOpenAiResponsesRequest` fallback branch (C4).
 */
export function sampleResponsesFallbackWireTrack(wire: PreparedRequest, env: RequestEnvelope): RequestSample {
  const effBody = env.body as { model?: unknown; messages?: unknown }
  const effective: EffectiveRequest = {
    model: typeof effBody.model === "string" ? effBody.model : "",
    resolvedModel: env.model as Model | undefined,
    messages: Array.isArray(effBody.messages) ? effBody.messages : [],
    payload: env.body,
    format: RESPONSES_ENDPOINT_TYPE,
  }

  const wireBody = wire.body as { model?: unknown; messages?: unknown }
  const wireRequest: WireRequest = {
    model: typeof wireBody.model === "string" ? wireBody.model : "",
    messages: Array.isArray(wireBody.messages) ? wireBody.messages : [],
    payload: wire.body,
    headers: Object.fromEntries(wire.headers.entries()),
    format: CC_ENDPOINT_TYPE,
  }

  return { effective, wire: wireRequest }
}
