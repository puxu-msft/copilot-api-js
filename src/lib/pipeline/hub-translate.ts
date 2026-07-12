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
 * cells are wired in Phase 5). The RESPONSE-side dispatch (`renderResponseVia`) is a Phase 3/4 skeleton
 * that throws — the translation legs stay end-to-end fail-fast until response translation lands.
 */

import type { Model } from "~/lib/models/client"
import type {
  //
  ClientFormat,
  UpstreamEndpoint,
} from "~/lib/pipeline/envelope"
import type { MessagesPayload } from "~/types/api/anthropic"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"
import type { ResponsesPayload } from "~/types/api/openai-responses"

import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  translateAnthropicToChatCompletions,
  translateChatCompletionsToAnthropic,
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
 * Response-side translation dispatch — Phase 3 (non-streaming) / Phase 4 (streaming) skeleton.
 *
 * Until response translation lands, a translation leg is INTENTIONALLY end-to-end fail-fast (RFC §7 /
 * the Phase-2 commit invariant): letting an anthropic→cc request reach the upstream and return a CC
 * response un-translated to the Anthropic client would return corrupt data. Throwing here (mirrored by
 * the codec's `renderResponse`/`getStreamMeta` fail-fast) makes the leg fail loudly instead. Phase 3/4
 * replace this with the real CC↔Anthropic response translators.
 */
export function renderResponseVia(): never {
  throw new Error(
    "[hub-translate] response-side translation is not wired yet (Phase 3 non-streaming / Phase 4 streaming) — translation legs are end-to-end fail-fast until then",
  )
}
