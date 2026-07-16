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
 * is wired here in Phase 3 (both directions; the `(anthropic, responses)` cell became a DIRECT single-hop
 * bridge in RFC 2026-07-14-anthropic-responses-direct-bridge §3, subtask B — see `responses-to-anthropic.ts`).
 * The STREAMING response-side dispatch is wired here in Phase 4 for the FORWARD legs via
 * {@link createForwardStreamTranslator} (a per-request stateful factory the anthropic codec drives
 * per-frame): the cc leg is a single hop (CC→Anthropic); the responses leg was originally a two-hop
 * (Responses→CC→Anthropic, WARN-F) but became a DIRECT single-hop bridge in the same RFC's subtask C — see
 * `responses-to-anthropic-stream.ts`. The REVERSE `→ messages` streaming cells stay Phase 5.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type { Model } from "~/lib/models/client"
import type {
  //
  ClientFormat,
  UpstreamEndpoint,
} from "~/lib/pipeline/envelope"
import type {
  //
  ClientFrame,
  UpstreamFrame,
} from "~/lib/pipeline/types"
import type {
  //
  Message as AnthropicResponse,
  MessagesPayload,
} from "~/types/api/anthropic"
import type {
  //
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/types/api/openai-chat-completions"
import type {
  //
  ResponsesPayload,
  ResponsesResponse,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  type AnthropicToCcStreamMeta,
  type AnthropicToCcStreamTranslator,
  type CcToAnthropicStreamMeta,
  type CcToAnthropicStreamTranslator,
  createAnthropicToCcStreamTranslator,
  createAnthropicToResponsesStreamTranslator,
  createCcToAnthropicStreamTranslator,
  createResponsesToAnthropicStreamTranslator,
  createStreamTranslator,
  translateAnthropicResponseToCC,
  translateAnthropicToChatCompletions,
  translateAnthropicToResponses,
  translateCCResponseToAnthropic,
  translateChatCompletionsToAnthropic,
  translateResponsesResponseToAnthropic,
  translateResponsesToAnthropicRequest,
  translateResponsesToChatCompletions,
  type ResponsesToAnthropicStreamTranslator,
  type TranslateExchangeContext,
} from "~/lib/openai/translate"

/** Per-request context the hub threads into the format translators. */
export interface HubTranslateContext {
  /** The resolved upstream model — gates the anthropic→cc `thinking`→`reasoning_effort` mapping (spec §6). */
  model?: Model
  /** The originating request id (`ctx.id`) — threaded to TAG the anthropic→cc lossy-drop warnings so they are traceable to their request. */
  reqId?: string
}

/**
 * RFC §4.3 scenario A/B decision, threaded into the anthropic↔responses direct-bridge RESPONSE-side
 * render functions ONLY (the reasoning round-trip's carrier population point). `undefined`/absent
 * `stripThinkingSignature` = scenario A (full round-trip, the default) — every OTHER bridge cell
 * (CC family, gemini, the reverse `→messages` CC/gemini legs) ignores this entirely, since scenario
 * B only has meaning for the direct anthropic↔responses reasoning carrier.
 */
export interface ReasoningRoundTripOptions {
  /** True ⇒ never populate the reasoning round-trip carrier (encrypted_content); plaintext summary/text still renders. */
  stripThinkingSignature?: boolean
}

/**
 * Request-side translation dispatch — RFC 2026-07-14 §2 per-pair bridge table (R-EXPLICIT). Was a
 * single-axis `if (targetEndpoint===MESSAGES) ... else ...` wrapping two `switch(sourceFormat){...
 * default:throw}` helpers (a runtime-throw fallback for an unhandled sourceFormat); now an EXHAUSTIVE
 * `Record<ClientFormat, Record<UpstreamEndpoint, RequestBridge>>` — a missing `(source,target)` cell is
 * a COMPILE error (`satisfies` below), not a runtime throw.
 *
 * `(anthropic, /chat/completions)` and `(anthropic, /responses | ws:/responses)` are deliberately
 * INDEPENDENT, separately-named entries (not one shared branch) even though both still produce a
 * CC-canonical body today (byte-identical) — this is the seam Phase 3 needs to replace ONLY the
 * `/responses` entry with the direct anthropic↔responses bridge without touching `/chat/completions`.
 *
 * `translate`-only: the driver only calls the hub when the route decided `translate` (a passthrough
 * leg's body is already in the right shape and never reaches here). A source==target-canonical pair
 * (e.g. openai-cc → a CC leg, or the defensive anthropic→/v1/messages identity) is nonetheless an
 * explicit identity bridge for completeness (every cell must resolve to SOMETHING, never `undefined`).
 */
type RequestBridge = (body: unknown, ctx?: HubTranslateContext) => unknown

/** Identity bridge — the source format IS the leg's hub-canonical shape already. */
const identityRequestBridge: RequestBridge = (body) => body

/** `anthropic → /chat/completions`: Anthropic Messages → CC-canonical. */
const anthropicToChatCompletionsBridge: RequestBridge = (body, ctx) =>
  translateAnthropicToChatCompletions(body as MessagesPayload, { model: ctx?.model, reqId: ctx?.reqId })

/**
 * `anthropic → /responses | ws:/responses`: Anthropic Messages → Responses-canonical DIRECT bridge
 * (RFC 2026-07-14-anthropic-responses-direct-bridge §3/§4.1) — skips the CC intermediate representation
 * entirely (no multi-choices fold, no CC tool_call-index bookkeeping — Responses' `input[]` granularity
 * needs neither). `env.body` becomes Responses-shaped HERE (at translateOut), unlike the sibling
 * `/chat/completions` bridge above which stops at CC — the responses leg's `prepareWire` /
 * `cc-family-strategies.ts` retry-baseline read `env.clientFormat==="anthropic"` to take the matching
 * Responses-shaped path (R-NO-INTERNAL-ADAPT: this is a genuine behavior change, not an internal-shape
 * refactor — the three call sites were updated together, RFC §2.3 three-point corner).
 */
const anthropicToResponsesBridge: RequestBridge = (body, ctx) =>
  translateAnthropicToResponses(body as MessagesPayload, { model: ctx?.model, reqId: ctx?.reqId })

/** `openai-cc | gemini → /v1/messages`: CC-canonical → Anthropic Messages (shared — no gemini-held Anthropic sub-codec). */
const ccToAnthropicRequestBridge: RequestBridge = (body) => translateChatCompletionsToAnthropic(body as ChatCompletionsPayload)

/**
 * `openai-responses → /v1/messages`: DIRECT bridge (RFC 2026-07-14-anthropic-responses-direct-bridge
 * §3/§4.2, Phase 4 subtask D) — a single fold of Responses `input[]` straight into Anthropic
 * `MessageParam[]`, skipping the CC intermediate entirely (was a two-hop Responses→CC→Anthropic, WARN-F).
 * This reverse request leg is purely hub-internal (RFC §2.3 — unlike the forward `@responses` request
 * leg, no three-point corner: the anthropic-messages leg's `translateOut`/`prepareWire`/retry-baseline
 * already treat a REVERSE cell's translated body as Anthropic-shaped regardless of source clientFormat).
 */
const responsesToAnthropicRequestBridge: RequestBridge = (body) => translateResponsesToAnthropicRequest(body as ResponsesPayload)

/** `openai-responses → /chat/completions | /responses | ws:/responses`: Responses → CC-canonical (the responses-leg CC→Responses re-translation happens later in `prepareWire`). */
const responsesToCcRequestBridge: RequestBridge = (body) => translateResponsesToChatCompletions(body as ResponsesPayload)

const REQUEST_BRIDGES = {
  anthropic: {
    // Defensive identity: the direct/passthrough path never routes here.
    [ENDPOINT.MESSAGES]: identityRequestBridge,
    [ENDPOINT.CHAT_COMPLETIONS]: anthropicToChatCompletionsBridge,
    [ENDPOINT.RESPONSES]: anthropicToResponsesBridge,
    [ENDPOINT.WS_RESPONSES]: anthropicToResponsesBridge,
  },
  "openai-cc": {
    [ENDPOINT.MESSAGES]: ccToAnthropicRequestBridge,
    // Already CC — identity for all three CC-shaped legs.
    [ENDPOINT.CHAT_COMPLETIONS]: identityRequestBridge,
    [ENDPOINT.RESPONSES]: identityRequestBridge,
    [ENDPOINT.WS_RESPONSES]: identityRequestBridge,
  },
  gemini: {
    // Gemini's body is normalized to CC by its parse, so it shares the cc→anthropic translator.
    [ENDPOINT.MESSAGES]: ccToAnthropicRequestBridge,
    [ENDPOINT.CHAT_COMPLETIONS]: identityRequestBridge,
    [ENDPOINT.RESPONSES]: identityRequestBridge,
    [ENDPOINT.WS_RESPONSES]: identityRequestBridge,
  },
  "openai-responses": {
    [ENDPOINT.MESSAGES]: responsesToAnthropicRequestBridge,
    [ENDPOINT.CHAT_COMPLETIONS]: responsesToCcRequestBridge,
    [ENDPOINT.RESPONSES]: responsesToCcRequestBridge,
    [ENDPOINT.WS_RESPONSES]: responsesToCcRequestBridge,
  },
} satisfies Record<ClientFormat, Record<UpstreamEndpoint, RequestBridge>>

export function translateRequestVia(sourceFormat: ClientFormat, targetEndpoint: UpstreamEndpoint, body: unknown, ctx?: HubTranslateContext): unknown {
  return REQUEST_BRIDGES[sourceFormat][targetEndpoint](body, ctx)
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

/**
 * Non-streaming response bridge for one `targetEndpoint` — RFC 2026-07-14 §2 per-pair bridge table
 * (R-EXPLICIT). Was a single-axis `if (targetEndpoint===MESSAGES) ... else ...` (the `else` branch
 * further branching on CC vs RESPONSES inline); now an EXHAUSTIVE `Record<UpstreamEndpoint, ...>` —
 * a missing leg is a COMPILE error via `satisfies`, not a silently-wrong fallthrough.
 */
type ResponseBridge = (upstream: unknown, opts?: ReasoningRoundTripOptions) => RenderedNonStreamingResponse

/** REVERSE `/v1/messages` leg: Anthropic upstream → CC-canonical (the client codec renders any further hop). */
const anthropicUpstreamToCcResponseBridge: ResponseBridge = (upstream) => ({
  rendered: translateAnthropicResponseToCC(upstream as AnthropicResponse),
  contentFiltered: false,
})

/** FORWARD `/chat/completions` leg (anthropic client): the upstream IS already CC — single-hop CC → Anthropic. */
const ccUpstreamToAnthropicResponseBridge: ResponseBridge = (upstream) => {
  const { response, contentFiltered } = translateCCResponseToAnthropic(upstream as ChatCompletionResponse)
  return { rendered: response, contentFiltered }
}

/**
 * FORWARD `/responses` | `ws:/responses` leg (anthropic client): DIRECT bridge (RFC
 * 2026-07-14-anthropic-responses-direct-bridge §3/§4.1) — a single-hop Responses → Anthropic walk,
 * skipping the CC intermediate (was a two-hop Responses → CC → Anthropic, WARN-F). Reached ONLY by the
 * anthropic codec's `renderResponseNonStreaming` for its FORWARD `@responses` leg — the openai-cc/gemini
 * via-responses cells call `translateResponsesResponseToCC` directly (never this bridge-table entry), so
 * swapping this one cell does not affect them. `opts.stripThinkingSignature` (Phase 5, RFC §4.3 scenario
 * B) is threaded straight through to the reasoning round-trip carrier — see `responses-to-anthropic.ts`.
 */
const responsesUpstreamToAnthropicResponseBridge: ResponseBridge = (upstream, opts) => {
  const { response, contentFiltered } = translateResponsesResponseToAnthropic(upstream as ResponsesResponse, opts)
  return { rendered: response, contentFiltered }
}

const RESPONSE_BRIDGES = {
  [ENDPOINT.MESSAGES]: anthropicUpstreamToCcResponseBridge,
  [ENDPOINT.CHAT_COMPLETIONS]: ccUpstreamToAnthropicResponseBridge,
  [ENDPOINT.RESPONSES]: responsesUpstreamToAnthropicResponseBridge,
  [ENDPOINT.WS_RESPONSES]: responsesUpstreamToAnthropicResponseBridge,
} satisfies Record<UpstreamEndpoint, ResponseBridge>

export function renderResponseNonStreamingVia(targetEndpoint: UpstreamEndpoint, upstream: unknown, opts?: ReasoningRoundTripOptions): RenderedNonStreamingResponse {
  return RESPONSE_BRIDGES[targetEndpoint](upstream, opts)
}

/**
 * Response-side STREAMING translation dispatch — Phase 4 (T4.1/T4.2/T4.3).
 *
 * A per-request stateful factory the anthropic codec drives per-frame (`renderResponse` →
 * {@link ForwardStreamTranslator.renderFrame}; stream-end → `flushResponse` → {@link
 * ForwardStreamTranslator.flush}; out-of-band terminal meta → `getStreamMeta` → {@link
 * ForwardStreamTranslator.getMeta}). Two FORWARD legs (dispatched purely on `targetEndpoint`):
 *   - `/chat/completions` (cc leg) — SINGLE hop: the upstream CC SSE stream is fed straight into the
 *     {@link createCcToAnthropicStreamTranslator} (T4.1).
 *   - `/responses` | `ws:/responses` (responses leg) — DIRECT single-hop bridge (RFC
 *     2026-07-14-anthropic-responses-direct-bridge §3, subtask C): the upstream Responses SSE stream
 *     feeds {@link createResponsesToAnthropicStreamTranslator} directly (was a TWO-hop
 *     Responses→CC→Anthropic via {@link createStreamTranslator} + {@link createCcToAnthropicStreamTranslator}
 *     — see `responses-to-anthropic-stream.ts` for the state-machine + terminal-meta details). The
 *     translator's `getMeta()` returns a {@link ResponsesToAnthropicStreamMeta} — a strict SUPERSET of
 *     {@link CcToAnthropicStreamMeta} (adds `contentFiltered`, N3 parity with the non-streaming bridge),
 *     so it satisfies `ForwardStreamTranslator.getMeta`'s type without a cast.
 *
 * The REVERSE `→ /v1/messages` streaming leg (Anthropic upstream → CC/gemini/responses client) stays
 * Phase 5 — {@link createForwardStreamTranslator} throws for it (never-swallow).
 */
export interface ForwardStreamTranslator {
  /** Translate ONE raw upstream SSE frame → 0+ Anthropic SSE frames. */
  renderFrame(frame: ClientFrame): Array<ClientFrame>
  /** Stream-end drain: the terminal Anthropic frames (close open block + message_delta + message_stop). */
  flush(): Array<ClientFrame>
  /** The terminal meta (Anthropic stop_reason + net usage) the owns-sink handler reads out-of-band. */
  getMeta(): CcToAnthropicStreamMeta
}

/**
 * Per-`targetEndpoint` STATEFUL factory table (RFC 2026-07-14 §2, R-EXPLICIT) — was a chained
 * `if (targetEndpoint===CHAT_COMPLETIONS) ... if (RESPONSES||WS_RESPONSES) ... throw` (a runtime-throw
 * fallback for the `/v1/messages` leg). Now an EXHAUSTIVE `Record<UpstreamEndpoint, ForwardStreamTranslatorFactory>`
 * — a missing leg is a COMPILE error via `satisfies`. Each entry constructs a FRESH per-request stateful
 * translator (not a plain value — a factory), preserving the existing per-request-instance semantics.
 * `/v1/messages` is an explicit, named "unreachable — reverse leg" factory (still an EXPLICIT bridge
 * table entry, not a `default` fallthrough — R-EXPLICIT requires every leg named, even the unreachable one).
 */
type ForwardStreamTranslatorFactory = (modelId: string, opts?: ReasoningRoundTripOptions) => ForwardStreamTranslator

/** `/chat/completions` (cc leg) — SINGLE hop: the upstream CC SSE stream feeds the CC→Anthropic translator directly. */
const chatCompletionsForwardStreamFactory: ForwardStreamTranslatorFactory = (modelId) => {
  const ccToAnthropic: CcToAnthropicStreamTranslator = createCcToAnthropicStreamTranslator(modelId)
  return {
    renderFrame: (frame) => ccToAnthropic.renderFrame(frame as ServerSentEventMessage).map((s) => s.frame),
    flush: () => ccToAnthropic.flush().map((s) => s.frame),
    getMeta: () => ccToAnthropic.getMeta(),
  }
}

/**
 * `/responses` | `ws:/responses` (responses leg) — DIRECT bridge (RFC 2026-07-14-anthropic-responses-direct-bridge
 * §3/§4.1, Phase 3 subtask C): the upstream Responses SSE stream feeds the single-hop
 * {@link createResponsesToAnthropicStreamTranslator} directly (was a two-hop Responses→CC→Anthropic via
 * {@link createStreamTranslator} + {@link createCcToAnthropicStreamTranslator}). The terminal meta is now
 * SELF-CONTAINED (this translator's own running state), not the CC accumulator's — phase-2-audit §3.3's
 * "第3类显式 helper" (a distinct terminal-meta concern the RFC calls out explicitly, not buried in "the
 * response translator"). `opts.stripThinkingSignature` (Phase 5, RFC §4.3 scenario B) threads straight
 * through to the reasoning round-trip carrier — see `responses-to-anthropic-stream.ts`.
 */
const responsesForwardStreamFactory: ForwardStreamTranslatorFactory = (modelId, opts) => {
  const direct: ResponsesToAnthropicStreamTranslator = createResponsesToAnthropicStreamTranslator(modelId, opts)
  return {
    renderFrame: (frame) => direct.renderFrame(frame as ServerSentEventMessage).map((s) => s.frame),
    flush: () => direct.flush().map((s) => s.frame),
    getMeta: () => direct.getMeta(),
  }
}

/**
 * `/v1/messages` — the REVERSE leg does not use the FORWARD translator: the reverse legs dispatch on
 * `clientFormat` via `createReverseStreamTranslator` (the upstream is Anthropic, so the render direction
 * is Anthropic→CC/Responses/Gemini). A forward call for the messages leg is a wiring bug — fail loudly
 * (never-swallow). Named + tabled explicitly (R-EXPLICIT: not a `default` catch-all).
 */
const messagesForwardStreamFactoryUnreachable: ForwardStreamTranslatorFactory = (): ForwardStreamTranslator => {
  throw new Error(
    `[hub-translate] createForwardStreamTranslator: the /v1/messages leg is a REVERSE leg — use createReverseStreamTranslator (dispatched on clientFormat), not the forward translator (targetEndpoint=${ENDPOINT.MESSAGES})`,
  )
}

const FORWARD_STREAM_FACTORIES = {
  [ENDPOINT.MESSAGES]: messagesForwardStreamFactoryUnreachable,
  [ENDPOINT.CHAT_COMPLETIONS]: chatCompletionsForwardStreamFactory,
  [ENDPOINT.RESPONSES]: responsesForwardStreamFactory,
  [ENDPOINT.WS_RESPONSES]: responsesForwardStreamFactory,
} satisfies Record<UpstreamEndpoint, ForwardStreamTranslatorFactory>

export function createForwardStreamTranslator(targetEndpoint: UpstreamEndpoint, modelId: string, opts?: ReasoningRoundTripOptions): ForwardStreamTranslator {
  return FORWARD_STREAM_FACTORIES[targetEndpoint](modelId, opts)
}

/**
 * Per-request Responses→CC per-frame renderer — the FORWARD via-responses render primitive (an openai-cc /
 * gemini client whose leg is `/responses`: the upstream is a Responses SSE stream that must be forwarded to
 * the client as CC chunks). Bundles the stateful {@link createStreamTranslator} so callers don't manage the
 * translator handle. `renderFrame` parses one upstream Responses frame and maps the resulting CC chunks to
 * `message`-event ClientFrames; unparseable / `[DONE]` frames yield `[]` (the sentinel is swallowed — a
 * per-frame translator never sees "stream end"). Extracted from the openai-cc codec so this Responses→CC
 * rendering lives with the other hub translation primitives (RFC 2026-07-13 §11 HIGH-1).
 */
export interface ResponsesToCcFrameRenderer {
  /** Translate ONE raw upstream Responses SSE frame → 0+ CC `message` ClientFrames. */
  renderFrame(frame: UpstreamFrame): Array<ClientFrame>
}

export function createResponsesToCcFrameRenderer(): ResponsesToCcFrameRenderer {
  const translator = createStreamTranslator()
  return {
    renderFrame(frame) {
      if (!frame.data || frame.data === "[DONE]") return []

      let event: ResponsesStreamEvent
      try {
        event = JSON.parse(frame.data) as ResponsesStreamEvent
      } catch (err) {
        consola.debug(`[cc←responses] skipping unparseable SSE frame (${err instanceof Error ? err.message : String(err)}):`, frame.data.slice(0, 200))
        return []
      }

      return translator.translate(event).map((chunk: ChatCompletionChunk): ClientFrame => ({ data: JSON.stringify(chunk), event: "message" }))
    },
  }
}

/**
 * Response-side STREAMING translation dispatch — REVERSE legs (Phase 5, T5.2/T5.3/T5.4).
 *
 * The mirror of {@link createForwardStreamTranslator}: a cc/responses/gemini client pinned to `@messages`
 * reaches a direct-Anthropic upstream leg, so the upstream is an Anthropic SSE stream and the render
 * direction is Anthropic→client-format. A per-request stateful factory the client codec drives per-frame
 * (`renderResponse` → {@link ReverseStreamTranslator.renderFrame}; stream-end → `flushResponse` →
 * {@link ReverseStreamTranslator.flush}; out-of-band terminal meta → `getStreamMeta` → {@link
 * ReverseStreamTranslator.getMeta}). Dispatched on `clientFormat` (the upstream is ALWAYS Anthropic for a
 * reverse leg — `targetEndpoint===/v1/messages` — so it does not vary the direction):
 *   - `openai-cc` / `gemini` — SINGLE hop: the upstream Anthropic SSE stream is fed straight into
 *     {@link createAnthropicToCcStreamTranslator}, producing CC-canonical frames. The gemini codec does a
 *     further CC→Gemini hop in its own render (T5.4); the hub stops at CC (parity with the non-streaming
 *     `renderResponseNonStreamingVia` returning CC-canonical).
 *   - `openai-responses` — DIRECT bridge (RFC 2026-07-14-anthropic-responses-direct-bridge §3/§4.2, Phase 4
 *     subtask F, Phase 5 reasoning round-trip carrier): the upstream Anthropic SSE stream feeds
 *     {@link createAnthropicToResponsesStreamTranslator} directly, a SINGLE hop (was a two-hop
 *     Anthropic→CC→Responses via {@link createAnthropicToCcStreamTranslator} +
 *     {@link createCCToResponsesStreamTranslator}, WARN-F — superseded).
 *
 * `getMeta` is the Anthropic→CC translator's meta (finishReason + grossed-up usage + sawMessageStop — the
 * F2 truncation signal) for the `openai-cc`/`gemini` legs; the `openai-responses` DIRECT leg's own
 * `AnthropicToResponsesStreamMeta` has no CC-shaped finishReason/usage to project, so its factory returns
 * an honest minimal `{ sawMessageStop }` (see `responsesReverseStreamFactory` below) rather than
 * fabricating CC fields it does not produce.
 */
export interface ReverseStreamTranslator {
  /** Translate ONE raw upstream Anthropic SSE frame → 0+ client-format SSE frames. */
  renderFrame(frame: ClientFrame): Array<ClientFrame>
  /** Stream-end drain: the client-format terminal frames (`[]` for cc; the Responses `response.completed` for responses). */
  flush(): Array<ClientFrame>
  /** The terminal meta (CC finish_reason + net usage + sawMessageStop) the owns-sink reverse pump reads out-of-band. */
  getMeta(): AnthropicToCcStreamMeta
}

/**
 * Per-`clientFormat` STATEFUL factory table (RFC 2026-07-14 §2, R-EXPLICIT) — was a chained
 * `if (clientFormat==="openai-cc"||"gemini") ... if ("openai-responses") ... throw` (a runtime-throw
 * fallback for the `anthropic` direct/passthrough clientFormat, which never reaches a reverse
 * translator). Now an EXHAUSTIVE `Record<ClientFormat, ReverseStreamTranslatorFactory>` — a missing
 * clientFormat is a COMPILE error via `satisfies`. Each entry constructs a FRESH per-request stateful
 * translator (a factory, not a plain value); `openai-responses`'s factory additionally threads the
 * `exchangeCtx` param (the second hop's responseId/itemId/clientModel).
 */
type ReverseStreamTranslatorFactory = (modelId: string, exchangeCtx?: TranslateExchangeContext, opts?: ReasoningRoundTripOptions) => ReverseStreamTranslator

/** `openai-cc` / `gemini` — SINGLE hop: the upstream Anthropic SSE stream feeds the Anthropic→CC translator directly. */
const ccFamilyReverseStreamFactory: ReverseStreamTranslatorFactory = (modelId) => {
  const anthropicToCc: AnthropicToCcStreamTranslator = createAnthropicToCcStreamTranslator(modelId)
  return {
    renderFrame: (frame) => anthropicToCc.renderFrame(frame as ServerSentEventMessage).map((s) => s.frame),
    flush: () => anthropicToCc.flush().map((s) => s.frame),
    getMeta: () => anthropicToCc.getMeta(),
  }
}

/**
 * `openai-responses` — DIRECT bridge (RFC 2026-07-14-anthropic-responses-direct-bridge §3/§4.2, Phase 4
 * subtask F): the upstream Anthropic SSE stream feeds
 * {@link createAnthropicToResponsesStreamTranslator} directly (was a TWO-hop Anthropic→CC→Responses via
 * {@link createAnthropicToCcStreamTranslator} + {@link createCCToResponsesStreamTranslator}). Reuses the
 * SAME `exchangeCtx` (responseId/itemId/clientModel) the old two-hop path already required — no new
 * exchange-context contract (mirrors subtask E's reuse of `TranslateExchangeContext`). `opts.stripThinkingSignature`
 * (Phase 5, RFC §4.3 scenario B) threads straight through to the reasoning round-trip carrier.
 */
const responsesReverseStreamFactory: ReverseStreamTranslatorFactory = (modelId, exchangeCtx, opts) => {
  if (!exchangeCtx) {
    throw new Error(
      "[hub-translate] createReverseStreamTranslator: the openai-responses reverse leg requires an exchangeCtx (responseId/itemId/clientModel) — the responses handler must build a reverse-exchange",
    )
  }
  const direct = createAnthropicToResponsesStreamTranslator(modelId, exchangeCtx, opts)
  return {
    renderFrame: (frame) => direct.renderFrame(frame as ServerSentEventMessage).map((s) => s.frame),
    flush: () => direct.flush().map((s) => s.frame),
    // The translator's own AnthropicToResponsesStreamMeta lacks `usage`/`finishReason` (CC-shaped fields);
    // ReverseStreamTranslator.getMeta's declared type is AnthropicToCcStreamMeta for interface uniformity
    // across all three reverse legs, but this leg's actual consumer (routes/responses/handler-v4.ts) reads
    // its OWN raw Anthropic accumulator for truncation classification, not this getMeta() — so an honest
    // minimal projection (sawMessageStop only) satisfies the interface without fabricating CC-shaped
    // finishReason/usage this leg's direct translator does not produce.
    getMeta: () => ({ sawMessageStop: direct.getMeta().sawMessageStop }),
  }
}

/**
 * `anthropic` — the direct/passthrough leg never reaches a reverse translator (render is identity).
 * Named + tabled explicitly (R-EXPLICIT: not a `default` catch-all) so the throw is a documented,
 * addressable table entry rather than a fallthrough branch.
 */
const anthropicReverseStreamFactoryUnreachable: ReverseStreamTranslatorFactory = (): ReverseStreamTranslator => {
  throw new Error("[hub-translate] createReverseStreamTranslator: unhandled clientFormat for a reverse /v1/messages leg: anthropic")
}

const REVERSE_STREAM_FACTORIES = {
  anthropic: anthropicReverseStreamFactoryUnreachable,
  "openai-cc": ccFamilyReverseStreamFactory,
  gemini: ccFamilyReverseStreamFactory,
  "openai-responses": responsesReverseStreamFactory,
} satisfies Record<ClientFormat, ReverseStreamTranslatorFactory>

export function createReverseStreamTranslator(
  clientFormat: ClientFormat,
  modelId: string,
  exchangeCtx?: TranslateExchangeContext,
  opts?: ReasoningRoundTripOptions,
): ReverseStreamTranslator {
  return REVERSE_STREAM_FACTORIES[clientFormat](modelId, exchangeCtx, opts)
}
