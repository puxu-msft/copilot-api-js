/**
 * v4 pipeline — hub-and-spoke shared translation layer (RFC 2026-07-11-anthropic-via-openai-translation §4.2).
 *
 * The single home for REQUEST-side protocol translation between the client format and the outbound
 * leg, so no FormatCodec re-implements the routing and — crucially — Gemini's `@messages` leg does
 * NOT need a Gemini-held Anthropic sub-codec (消解 W-gemini 双委托): every `→ messages` leg flows
 * through the hub's `cc → anthropic` translator, and the responses/gemini bodies reach it already
 * normalized to CC.
 *
 * "Hub-canonical" logical body per leg (the shape `env.body` carries through S3/S4):
 *   - `/v1/messages` leg → an Anthropic Messages body.
 *   - `/chat/completions` / `/responses` legs → a CC (Chat Completions) body. The CC→Responses WIRE
 *     translation for the `/responses` leg stays in the codec's `prepareWire` (openai-cc precedent
 *     P2.2-D1: keeping `env.body` CC-shaped lets the CC request rewrites + auto-truncate operate on
 *     a CC shape), so this layer stops at CC for both OpenAI legs.
 *
 * Phase 2 scope: the REQUEST dispatch (`translateRequestVia`) — every (sourceFormat × targetEndpoint)
 * cell resolves to the right translator, whether or not a codec consumes it yet (the forward
 * anthropic→cc/responses cells are wired by the anthropic codec in T2.4; the reverse `→ messages`
 * cells are wired in Phase 5). The NON-STREAMING RESPONSE-side dispatch (`renderResponseNonStreamingVia`)
 * is wired here in Phase 3 (both directions); the STREAMING response-side dispatch (`renderResponseVia`)
 * stays a Phase 4 skeleton that throws — streaming translation legs stay end-to-end fail-fast until then.
 */

import type { Model } from "~/lib/models/client"
import type {
  //
  ClientFormat,
  UpstreamEndpoint,
} from "~/lib/pipeline/envelope"
import type { Message as AnthropicResponse, MessagesPayload } from "~/types/api/anthropic"
import type { ChatCompletionResponse, ChatCompletionsPayload } from "~/types/api/openai-chat-completions"
import type { ResponsesPayload, ResponsesResponse } from "~/types/api/openai-responses"

import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  translateAnthropicResponseToCC,
  translateAnthropicToChatCompletions,
  translateCCResponseToAnthropic,
  translateChatCompletionsToAnthropic,
  translateResponsesResponseToCC,
  translateResponsesToChatCompletions,
} from "~/lib/openai/translate"

/** Per-request context the hub threads into the format translators. */
export interface HubTranslateContext {
  /** The resolved upstream model — gates the anthropic→cc `thinking`→`reasoning_effort` mapping (spec §6). */
  model?: Model
}

/**
 * Request-side translation dispatch: the `sourceFormat` logical body → the `targetEndpoint` leg's
 * hub-canonical logical body (see the module docstring for the per-leg canonical shape).
 *
 * `translate`-only: the driver only calls the hub when the route decided `translate` (a passthrough
 * leg's body is already in the right shape and never reaches here). A source==target-canonical pair
 * (e.g. openai-cc → a CC leg) is nonetheless returned identity for completeness / defensiveness.
 */
export function translateRequestVia(sourceFormat: ClientFormat, targetEndpoint: UpstreamEndpoint, body: unknown, ctx?: HubTranslateContext): unknown {
  if (targetEndpoint === ENDPOINT.MESSAGES) {
    return toAnthropicBody(sourceFormat, body)
  }
  // /chat/completions, /responses, ws:/responses → CC-canonical (the codec's prepareWire does the
  // CC→Responses wire step for the responses leg).
  return toCcBody(sourceFormat, body, ctx)
}

/** Reverse legs (`→ /v1/messages`): produce an Anthropic Messages body from the source format. */
function toAnthropicBody(sourceFormat: ClientFormat, body: unknown): unknown {
  switch (sourceFormat) {
    case "anthropic": {
      // Already Anthropic (the direct/passthrough path never routes here — defensive identity).
      return body
    }
    case "openai-cc":
    case "gemini": {
      // Gemini's body is normalized to CC by its parse, so both share the cc→anthropic translator.
      return translateChatCompletionsToAnthropic(body as ChatCompletionsPayload)
    }
    case "openai-responses": {
      // Two-hop (WARN-F): Responses → CC → Anthropic, reusing the existing Responses↔CC primitive.
      return translateChatCompletionsToAnthropic(translateResponsesToChatCompletions(body as ResponsesPayload))
    }
    default: {
      throw new Error(`[hub-translate] unhandled sourceFormat for the /v1/messages leg: ${String(sourceFormat)}`)
    }
  }
}

/** Forward legs (`→ /chat/completions` | `/responses`): produce a CC-canonical body from the source format. */
function toCcBody(sourceFormat: ClientFormat, body: unknown, ctx?: HubTranslateContext): unknown {
  switch (sourceFormat) {
    case "anthropic": {
      return translateAnthropicToChatCompletions(body as MessagesPayload, ctx?.model ? { model: ctx.model } : undefined)
    }
    case "openai-cc":
    case "gemini": {
      // Already CC (gemini's parse normalized it) — identity.
      return body
    }
    case "openai-responses": {
      // Responses → CC (the existing forward primitive); the responses-leg CC→Responses re-translation
      // happens later in prepareWire, so stopping at CC here is correct.
      return translateResponsesToChatCompletions(body as ResponsesPayload)
    }
    default: {
      throw new Error(`[hub-translate] unhandled sourceFormat for the CC-canonical leg: ${String(sourceFormat)}`)
    }
  }
}

/**
 * Response-side NON-STREAMING translation dispatch — Phase 3 (T3.3).
 *
 * The mirror of {@link translateRequestVia}, dispatched purely on `targetEndpoint` (which fully
 * determines the upstream response shape + the render direction):
 *   - `/v1/messages` leg → the upstream is an Anthropic response (a REVERSE `→ messages` leg); render
 *     it to CC-canonical (the cc/responses/gemini client codec does any further CC→its-format hop — WARN-F).
 *   - `/chat/completions` | `/responses` legs → the upstream is a CC / Responses response (a FORWARD
 *     anthropic→cc/responses leg); normalize it to CC (identity for the cc leg; Responses→CC for the
 *     responses leg — the WARN-F two-hop) then render CC→Anthropic.
 *
 * Returns a small envelope so the FORWARD path can surface the `contentFiltered` degradation (N3) to
 * the codec's ctx observability WITHOUT the pure translators taking a ctx dependency. The STREAMING
 * response side stays the {@link renderResponseVia} fail-fast skeleton (Phase 4).
 */
export interface RenderedNonStreamingResponse {
  /** The rendered response body in the client-canonical shape (Anthropic for a forward leg, CC for a reverse leg). */
  rendered: unknown
  /** FORWARD leg only: a CC choice finished with `content_filter` (mapped to end_turn on the wire, N3). */
  contentFiltered: boolean
}

export function renderResponseNonStreamingVia(targetEndpoint: UpstreamEndpoint, upstream: unknown): RenderedNonStreamingResponse {
  if (targetEndpoint === ENDPOINT.MESSAGES) {
    // REVERSE leg: Anthropic upstream → CC-canonical (the client codec renders any further hop).
    return { rendered: translateAnthropicResponseToCC(upstream as AnthropicResponse), contentFiltered: false }
  }
  // FORWARD leg (anthropic client): normalize the upstream to CC, then CC → Anthropic.
  const cc = targetEndpoint === ENDPOINT.CHAT_COMPLETIONS ? (upstream as ChatCompletionResponse) : translateResponsesResponseToCC(upstream as ResponsesResponse)
  const { response, contentFiltered } = translateCCResponseToAnthropic(cc)
  return { rendered: response, contentFiltered }
}

/**
 * Response-side STREAMING translation dispatch — Phase 4 skeleton.
 *
 * Until STREAMING response translation lands, a streaming translation leg is INTENTIONALLY end-to-end
 * fail-fast (RFC §7 / the Phase-2 commit invariant): letting an anthropic→cc request reach the upstream
 * and return CC frames un-translated to the Anthropic client would forward corrupt data. Throwing here
 * (mirrored by the codec's per-frame `renderResponse` fail-fast) makes the leg fail loudly instead. The
 * NON-STREAMING path is wired (see {@link renderResponseNonStreamingVia}); Phase 4 replaces this with the
 * real CC↔Anthropic streaming translators.
 */
export function renderResponseVia(): never {
  throw new Error(
    "[hub-translate] STREAMING response-side translation is not wired yet (Phase 4) — streaming translation legs are end-to-end fail-fast until then (non-streaming is wired via renderResponseNonStreamingVia)",
  )
}
