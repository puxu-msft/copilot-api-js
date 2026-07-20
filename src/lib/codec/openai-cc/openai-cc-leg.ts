/**
 * The `/chat/completions` OUTBOUND leg (Chat Completions wire) algorithm cores, extracted VERBATIM from
 * the openai-cc codec (C3 of the CellAssembly refactor, RFC 2026-07-13 §11). These are the CC-wire prep +
 * two-track sampling primitives the `/chat/completions` outbound leg needs — already pure over `env`
 * (+ the prepared wire), so the extraction is byte-for-byte identical (the CC http golden locks it).
 *
 * WHY a shared module: both the openai-cc codec (transitionally, until C3's driver fork routes the CC
 * cells through `OUTBOUND_LEGS[CHAT_COMPLETIONS]`) and the assembly call the SAME functions — zero byte
 * divergence. Only the `/chat/completions` branch lives here; the codec keeps its `/responses`
 * (via-responses) + reverse `@messages` branches (the via-responses wire is extracted in C4).
 *
 * The three cells that share this leg (`(openai-cc, /chat)` direct + `(anthropic, /chat)` / `(gemini,
 * /chat)` forward) all reach it with an already-CC-shaped `env.body` (direct = native; forward = the
 * hub's Anthropic/Gemini→CC translateOut), so the same wire prep serves all three.
 */

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
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  fillMaxCompletionTokens,
  prepareChatCompletionsRequest,
} from "~/lib/openai/request-preparation"

const ENDPOINT_TYPE: EndpointType = "openai-chat-completions"

/**
 * S4 last-mile for the `/chat/completions` leg: O10 `max_completion_tokens` fill (wire-only, two-track)
 * + `prepareChatCompletionsRequest` (O8/O9). Idempotent (pure function of `env.body` + model). Extracted
 * VERBATIM from the openai-cc codec's `prepareOpenAiCcWire` CHAT_COMPLETIONS branch (C3).
 */
export function prepareChatCompletionsWire(env: RequestEnvelope): PreparedRequest {
  const model = env.model as Model | undefined
  const ccPayload = fillMaxCompletionTokens(env.body as ChatCompletionsPayload, model)
  const prepared = prepareChatCompletionsRequest(ccPayload, { resolvedModel: model })
  return {
    url: ENDPOINT.CHAT_COMPLETIONS,
    headers: new Headers(prepared.headers),
    body: prepared.wire,
    stream: prepared.wire.stream ?? false,
  }
}

/**
 * S4 observability for the `/chat/completions` leg: the two history tracks, both `openai-chat-completions`.
 *   - `effective` = the CC-shaped post-rewrite logical request (`env.body`).
 *   - `wire` = the actual outbound CC bytes (`messages`, sanitized headers).
 *
 * Extracted VERBATIM from the openai-cc codec's `sampleOpenAiCcRequest` CC (non-MESSAGES, non-RESPONSES)
 * branch (C3). The wire-trim divergence documented there (O10 fill lands on `wire`, never `effective`)
 * still holds — this samples the same `env.body` for effective and the same prepared `wire`.
 */
export function sampleChatCompletionsWireTrack(wire: PreparedRequest, env: RequestEnvelope): RequestSample {
  const effBody = env.body as { model?: unknown; messages?: unknown }
  const effective: EffectiveRequest = {
    model: typeof effBody.model === "string" ? effBody.model : "",
    resolvedModel: env.model as Model | undefined,
    messages: Array.isArray(effBody.messages) ? effBody.messages : [],
    payload: env.body,
    format: ENDPOINT_TYPE,
  }

  const wireBody = wire.body as { model?: unknown; messages?: unknown }
  const wireRequest: WireRequest = {
    model: typeof wireBody.model === "string" ? wireBody.model : "",
    messages: Array.isArray(wireBody.messages) ? wireBody.messages : [],
    payload: wire.body,
    headers: Object.fromEntries(wire.headers.entries()),
    format: ENDPOINT_TYPE,
  }

  return { effective, wire: wireRequest }
}
