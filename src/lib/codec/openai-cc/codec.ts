/**
 * v4 pipeline — openai-cc FormatCodec (P2.2).
 *
 * Encapsulates everything that makes the Chat Completions client format differ
 * from the inbound HTTP / upstream wire: parse, route decision, the last-mile
 * wire prep (incl. the CC→Responses bridge), per-frame response render (incl.
 * the Responses→CC bridge), the error-frame shape, and the response accumulator
 * factory. openai-cc is the "translation hub" — the Gemini codec (P2.5) delegates
 * its CC-payload handling here.
 *
 * **Per-request stateful factory.** `createOpenAiCcCodec()` is constructed once
 * per request (the route builds the driver, and thus the codec, per request).
 * The instance is a *coding session*: it may hold per-request state in the
 * closure — here the lazily-built Responses→CC stream translator, whose
 * cross-frame state (tool-call index map, response id, sentFirstChunk) the
 * per-frame `renderResponse` interface has no slot for. This is the codec
 * paradigm, not a workaround (docs/v4/03-spec/codec.md §1).
 *
 * **Scope (P2.2):** this commit builds and unit-tests the codec; it is NOT wired
 * into any route (the legacy `handleChatCompletion` stays in use; P2.3 switches
 * the route to the driver behind a feature flag). The invariant is "codec unit
 * tests green", not behavior equivalence (equivalence is P2.3's invariant).
 *
 * Deferred to P2.3 (registered in docs/v4/05-progress.md):
 * - **P2.2-D1**: `prepareWire` performs the full CC→Responses translation (not a
 *   "last-mile trim"), deviating from retry-transport.md §3 — forced because the
 *   auto-truncate strategy assumes `env.body` is CC-shaped and the strategy
 *   interface only hands it `env` (no CC-original). See `prepareWire` JSDoc.
 * - **P2.2-D2**: the via-responses trailing `[DONE]` sentinel is NOT synthesized
 *   here — a closure translator never emits it. See `renderResponse` JSDoc.
 * - **P2.2-D3**: async config-driven system-prompt injection is NOT in `parse`
 *   (parse is sync). See `parse` JSDoc.
 * - **P2.2-D4**: `formatError` receives only the classified kind (locked
 *   signature), so it cannot forward the raw upstream error message the legacy
 *   handler does. See `formatError` JSDoc.
 * - **P2.2-D5**: `env.model` is non-optional, but CC supports unknown gpt-*
 *   fallback models absent from the index. See `parse` JSDoc.
 */

import consola from "consola"

import type { BetaProbe } from "~/lib/anthropic/pipeline"
import type { RequestContext } from "~/lib/context/request"
import type {
  //
  EffectiveRequest,
  WireRequest,
} from "~/lib/context/types"
import type { EndpointType } from "~/lib/history/store"
import type { Model } from "~/lib/models/client"
import type { AnthropicToCcStreamMeta } from "~/lib/openai/translate"
import type {
  //
  ClientFormat,
  LazyMessageView,
  NeutralMessage,
  NeutralSystem,
  NeutralTool,
  RequestEnvelope,
  ResolvedModel,
  UpstreamEndpoint,
} from "~/lib/pipeline/envelope"
import type { RequestState } from "~/lib/pipeline/request-state"
import type {
  //
  ClassifiedStreamError,
  ClientFrame,
  FormatCodec,
  PreparedRequest,
  RawHttpRequest,
  RequestSample,
  ResponseAccumulator,
  UpstreamFrame,
} from "~/lib/pipeline/types"
import type { PrepareHints } from "~/lib/request/pipeline"
import type {
  //
  ChatCompletionChunk,
  ChatCompletionsPayload,
  Message,
} from "~/types/api/openai-chat-completions"
import type {
  //
  ResponsesResponse,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import { createAnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import { prepareReverseAnthropicWire } from "~/lib/codec/anthropic/anthropic-leg"
import { getRequestContextManager } from "~/lib/context/manager"
import {
  //
  captureInboundHeaders,
} from "~/lib/fetch-utils"
import {
  //
  getAgentIdFromHeaders,
  getSessionIdFromHeaders,
} from "~/lib/history/store"
import {
  //
  ENDPOINT,
} from "~/lib/models/endpoint"
import {
  //
  resolveModelTarget,
  type RouteOverride,
} from "~/lib/models/resolver"
import { sanitizeOpenAIMessages } from "~/lib/openai/sanitize"
import { createOpenAIStreamAccumulator } from "~/lib/openai/stream-accumulator"
import { streamErrorKindToOpenAIErrorType } from "~/lib/openai/stream-error"
import {
  //
  applyChatCompletionsToolNameSanitization,
  buildChatCompletionsToolNameMapper,
} from "~/lib/openai/tool-name-sanitize"
import {
  //
  createStreamTranslator,
  translateResponsesResponseToCC,
} from "~/lib/openai/translate"
import {
  //
  createReverseStreamTranslator,
  renderResponseNonStreamingVia,
  type ReverseStreamTranslator,
  translateRequestVia,
} from "~/lib/pipeline/hub-translate"
import { state } from "~/lib/state"

import type { ReverseAnthropicMapperHolder } from "./reverse-anthropic-rewrite"

import {
  //
  prepareChatCompletionsWire,
  sampleChatCompletionsWireTrack,
} from "./openai-cc-leg"

import {
  //
  prepareViaResponsesWire,
  sampleViaResponsesWireTrack,
} from "~/lib/codec/openai-responses/openai-responses-leg"

const CLIENT_FORMAT: ClientFormat = "openai-cc"
const ENDPOINT_TYPE: EndpointType = "openai-chat-completions"
/** History `format` label for the REVERSE `@messages`-leg wire (the actual upstream endpoint). */
const ANTHROPIC_MESSAGES_ENDPOINT_TYPE: EndpointType = "anthropic-messages"

/** A per-request Responses→CC stream translator (created lazily on first via-responses frame). */
type StreamTranslator = ReturnType<typeof createStreamTranslator>

/**
 * The openai-cc codec, widened beyond {@link FormatCodec} with the per-request
 * truncation baseline accessor. The driver consumes it as a plain `FormatCodec`;
 * the route reads {@link OpenAiCcCodec.getTruncateBaseline} (after `parse`) to
 * build the auto-truncate strategy with the stable un-sanitized baseline.
 */
export interface OpenAiCcCodec extends FormatCodec {
  /**
   * The truncation baseline captured by `parse`: the un-sanitized, post-tool-rename
   * CC payload the auto-truncate strategy re-truncates from each retry (never the
   * mutated `env.body`). `undefined` before `parse` runs.
   */
  getTruncateBaseline(): ChatCompletionsPayload | undefined
  /**
   * The RequestContext created by `parse` (via `manager.create`). The route reads
   * it to `c.set("requestContext")` + settle the ctx on a failure that throws
   * before the envelope is otherwise reachable (parse-period error). `undefined`
   * before `parse` runs.
   */
  getContext(): RequestContext | undefined
  /**
   * REVERSE `@messages`-leg STREAMING drain (Phase 5, T5.2): the Anthropic→CC stream translator's
   * terminal frames (`[]` for the CC leg — finish + usage are inline on message_delta). Returns `[]`
   * for the direct/forward legs. The reverse pump calls it after the driver loop for interface
   * uniformity (mirrors the anthropic codec's forward `flushResponse`).
   */
  flushResponse(env: RequestEnvelope): Array<ClientFrame>
  /**
   * REVERSE `@messages`-leg terminal stream meta (Phase 5): the CC `finish_reason` (undefined ⇒
   * truncation, F2) + grossed-up usage the Anthropic→CC translator accumulated. `undefined` for the
   * direct/forward legs (their pumps read their own accumulator).
   */
  getStreamMeta(): AnthropicToCcStreamMeta | undefined
}

/** Args for {@link createOpenAiCcCodec}. */
export interface CreateOpenAiCcCodecArgs {
  /**
   * REVERSE `@messages` leg only: the shared per-request beta probe (also injected into the reverse
   * Anthropic strategies). `prepareWire` records the outbound Anthropic betas into it so the
   * unsupported-beta strategy can probe them. Absent for the forward/direct CC legs.
   */
  reverseBetaProbe?: BetaProbe
  /**
   * REVERSE `@messages` leg only: the shared per-request mapper holder. `parse` threads it onto
   * `env.requestState` so the `OUTBOUND_LEGS[/v1/messages]` reverse branch (C2b) reads the SAME instance
   * for both its sanitize rewrite and its resanitize (auto-truncate). Absent for the forward/direct CC legs.
   */
  reverseMapperHolder?: ReverseAnthropicMapperHolder
}

/**
 * Build the openai-cc codec for one request. The returned instance holds the
 * per-request Responses→CC translator + truncation baseline in its closure (see
 * module docstring).
 */
export function createOpenAiCcCodec(args?: CreateOpenAiCcCodecArgs): OpenAiCcCodec {
  // Lazily created on the first via-responses frame; persists across frames so
  // its cross-frame state (tool-call index map, response id) survives.
  let streamTranslator: StreamTranslator | null = null
  // The auto-truncate baseline, captured by parse (see OpenAiCcCodec).
  let truncateBaseline: ChatCompletionsPayload | undefined
  // The RequestContext created by parse (for route-side c.set + failure settle).
  let requestContext: RequestContext | undefined
  // REVERSE `@messages` leg (Phase 5): the per-request Anthropic→CC stream translator, built lazily on
  // the first reverse streaming `renderResponse`. `flushResponse` / `getStreamMeta` read the SAME instance.
  let reverseTranslator: ReverseStreamTranslator | undefined
  const ensureReverseTranslator = (env: RequestEnvelope): ReverseStreamTranslator => {
    const modelId = (env.model as Model | undefined)?.id ?? (env.body as { model?: string }).model ?? ""
    return (reverseTranslator ??= createReverseStreamTranslator(CLIENT_FORMAT, modelId))
  }

  return {
    format: CLIENT_FORMAT,

    parse(raw) {
      const { env, baseline } = parseOpenAiCc(raw)
      truncateBaseline = baseline
      requestContext = env.ctx
      // Attach the request-lifecycle-STABLE outbound-leg supply (RFC §11.2 / R2) so the CellAssembly reads
      // it from `env.requestState` instead of this codec closure. The `truncateBaseline` (the auto-truncate
      // baseline) is populated for EVERY CC request (C3 — the direct/forward `/chat/completions` cells read
      // it via `OUTBOUND_LEGS[CHAT_COMPLETIONS]`). The REVERSE `@messages` leg supply (C2b — the shared beta
      // probe + mapper holder) is added when the handler injects them; both coexist on requestState. Populating
      // requestState is also the driver's cell-keyed fork discriminator (an env without it stays legacy).
      return env.with({
        requestState: {
          truncateBaseline: baseline,
          ...(args?.reverseBetaProbe && { betaProbe: args.reverseBetaProbe }),
          ...(args?.reverseMapperHolder && { reverseMapperHolder: args.reverseMapperHolder }),
        },
      })
    },

    getTruncateBaseline() {
      return truncateBaseline
    },

    getContext() {
      return requestContext
    },

    // S2 translateOut: identity for the forward/direct CC legs (the CC→Responses translation lives in
    // prepareWire — P2.2-D1). A REVERSE `@messages` leg (Phase 5) delegates to the hub, producing an
    // Anthropic-canonical body (`env.body` becomes Anthropic-shaped from here on, so prepareWire below
    // builds the Anthropic wire).
    translateOut(env) {
      if (env.targetEndpoint !== ENDPOINT.MESSAGES) return env
      const anthropicBody = translateRequestVia(CLIENT_FORMAT, env.targetEndpoint, env.body, { model: env.model as Model | undefined })
      return env.with({ body: anthropicBody })
    },

    prepareWire(env) {
      // REVERSE `@messages` leg: the body is Anthropic-shaped (translateOut delegated to the hub) → build
      // the Anthropic wire via `prepareAnthropicRequest` (B1-B12). No client anthropic-beta (a CC client
      // sends none); the handler's beta probe records the outbound betas so unsupported-beta can probe them.
      if (env.targetEndpoint === ENDPOINT.MESSAGES) return prepareReverseAnthropicWire(env, args?.reverseBetaProbe)
      return prepareOpenAiCcWire(env)
    },

    renderResponse(frame, env) {
      // Passthrough (/chat/completions): forward the upstream CC frame verbatim.
      if (env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS) return frame
      // REVERSE `@messages` leg (Phase 5): the upstream is Anthropic → translate each frame to CC via the
      // per-request Anthropic→CC translator (getStreamMeta/flushResponse read the SAME instance).
      if (env.targetEndpoint === ENDPOINT.MESSAGES) return ensureReverseTranslator(env).renderFrame(frame)
      // via-responses (/responses): translate each Responses SSE frame → CC chunk(s).
      streamTranslator ??= createStreamTranslator()
      return renderResponsesFrameToCc(frame, streamTranslator)
    },

    renderResponseNonStreaming(upstream, env) {
      // REVERSE `@messages` leg (Phase 5): the upstream is Anthropic → CC-canonical (the hub reverse render).
      if (env.targetEndpoint === ENDPOINT.MESSAGES) return renderResponseNonStreamingVia(ENDPOINT.MESSAGES, upstream).rendered
      if (env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS) return upstream
      return translateResponsesResponseToCC(upstream as ResponsesResponse)
    },

    // REVERSE `@messages` leg streaming drain (Phase 5): the Anthropic→CC translator's terminal frames
    // (`[]` for the CC leg — finish/usage are inline). `[]` for the forward/direct legs.
    flushResponse(env) {
      if (env.targetEndpoint !== ENDPOINT.MESSAGES) return []
      return ensureReverseTranslator(env).flush()
    },

    // REVERSE `@messages` leg terminal meta (Phase 5): the CC finish_reason + net usage the translator
    // accumulated (undefined finish ⇒ truncation, F2). Undefined until a reverse renderResponse has run.
    getStreamMeta() {
      return reverseTranslator?.getMeta()
    },

    formatError(err, _env) {
      return formatOpenAiCcError(err)
    },

    createResponseAccumulator(env): ResponseAccumulator {
      // The OUTBOUND-leg accumulator (RFC §4.1): the forward/via-responses legs' upstream is CC-shaped;
      // a REVERSE `@messages` leg's upstream is Anthropic → the Anthropic accumulator (feeding the wrong
      // format's frames would produce a malformed outboundResponse, violating richest-data-flow).
      if (env.targetEndpoint === ENDPOINT.MESSAGES) return createAnthropicStreamAccumulator()
      return createOpenAIStreamAccumulator()
    },

    sampleRequest(wire, env): RequestSample {
      return sampleOpenAiCcRequest(wire, env)
    },
  }
}

// ============================================================================
// S1 — parse
// ============================================================================

/**
 * S1: inbound HTTP → envelope. **Synchronous** (the FormatCodec.parse contract).
 *
 * Does: Azure deployment override (path wins), `resolveModelName` + model index
 * lookup, RequestContext creation + inbound sampling (original snapshot, headers,
 * tool-name mapper, resolved model), request-side tool-name sanitization, and
 * `sanitizeOpenAIMessages`. `env.body` becomes the sanitized + tool-renamed CC
 * payload (CC-shaped — translation to Responses is deferred to `prepareWire`).
 *
 * **P2.2-D3 (deferred):** async config-driven system-prompt injection
 * (`processOpenAIMessages`, which awaits `applyConfigToState`) is NOT done here —
 * the parse contract is synchronous and the injection is non-idempotent. P2.3
 * wires it as a route pre-step that `await`s the injection into `raw.body`
 * BEFORE calling `codec.parse(raw)`, keeping parse sync + pure.
 *
 * **P2.2-D5 (deferred):** `env.model` is non-optional `ResolvedModel`, but CC
 * supports unknown gpt-* fallback models absent from the index (`modelIndex.get`
 * returns undefined). We store the (possibly undefined) selected model cast to
 * `ResolvedModel`; every consumer here passes it to helpers that accept
 * `Model | undefined` (e.g. `isEndpointSupported`), so the runtime is correct —
 * only the static type over-claims. P2.3 may relax the envelope to
 * `ResolvedModel | undefined` once Anthropic's non-optional assumption is revisited.
 */
function parseOpenAiCc(raw: RawHttpRequest): { env: RequestEnvelope; baseline: ChatCompletionsPayload } {
  // `body` is the wire-logical inbound (system-prompt already injected by the
  // route, P2.2-D3); `originalBodyForHistory` (when present) is the client's raw
  // pre-injection body for the history snapshot.
  const incoming = raw.body as ChatCompletionsPayload
  const clientBody = (raw.originalBodyForHistory ?? raw.body) as ChatCompletionsPayload

  // Snapshot the CLIENT raw (pre-rewrite, pre-system-prompt) for history.
  const originalSnapshot = structuredClone(clientBody)

  // Azure deployment routes inject the deployment name as an explicit override
  // (path wins over body.model). It defines the effective requested model.
  const clientModel = raw.modelOverride ?? incoming.model
  // Prefer the route's pre-reload resolution (legacy timing — before the
  // system-prompt config reload, P2.2-D3); else resolve + look up here.
  const resolvedTarget = raw.preResolved ?? resolveModelTarget(clientModel)
  const resolvedName = resolvedTarget.name
  const routeOverride = resolvedTarget.routeOverride
  if (resolvedName !== clientModel) consola.debug(`Model name resolved: ${clientModel} → ${resolvedName}`)
  const selectedModel = raw.preResolved ? raw.preResolved.model : state.modelIndex.get(resolvedName)

  // Create the request context (triggers "created" → history insert).
  const manager = getRequestContextManager()
  const reqBodySize = parseContentLength(raw.headers.get("content-length"))
  const ctx = manager.create({
    endpoint: ENDPOINT_TYPE,
    sessionId: getSessionIdFromHeaders(raw.headers),
    agentId: getAgentIdFromHeaders(raw.headers),
    ...(raw.path !== undefined && { rawPath: raw.path, path: raw.path }),
    ...(raw.method !== undefined && { method: raw.method }),
    ...(reqBodySize !== undefined && { requestBodySize: reqBodySize }),
  })

  ctx.setOriginalRequest({
    model: clientModel, // client's original (pre-resolution) name
    messages: originalSnapshot.messages as unknown as Array<unknown>,
    stream: originalSnapshot.stream ?? false,
    tools: originalSnapshot.tools?.map((t) => ({ name: t.function.name, description: t.function.description })),
    payload: originalSnapshot,
  })
  ctx.setInboundRequestHeaders(captureInboundHeaders(raw.headers))

  // Tool-name sanitization (client → upstream) over the wire-logical body. The
  // mapper is stored on ctx so the response-side restore can reverse it.
  const resolvedPayload: ChatCompletionsPayload = { ...incoming, model: resolvedName }
  const toolNameMapper = buildChatCompletionsToolNameMapper(resolvedPayload, selectedModel?.vendor)
  ctx.setToolNameMapper(toolNameMapper)
  const renamedPayload = applyChatCompletionsToolNameSanitization(resolvedPayload, toolNameMapper)

  ctx.setResolvedModel({
    resolved: resolvedName,
    ...(clientModel !== resolvedName && { client: clientModel }),
  })

  // Sanitize messages (orphan tool blocks, system-reminders). O10
  // (fillMaxCompletionTokens) is deferred to prepareWire (the two-track model:
  // it is an outbound-wire trim, not part of the effectiveRequest body).
  const { payload: sanitizedPayload } = sanitizeOpenAIMessages(renamedPayload)

  const env = makeEnvelope({
    targetEndpoint: ENDPOINT.CHAT_COMPLETIONS, // initial; the driver overwrites it after S2 routing (see lib/pipeline/router)
    ...(routeOverride && { routeOverride }),
    model: selectedModel as ResolvedModel,
    stream: sanitizedPayload.stream ?? false,
    body: sanitizedPayload,
    ctx,
  })

  // `renamedPayload` (post-tool-rename, PRE-sanitize) is the stable auto-truncate
  // baseline — matching the legacy `originalPayload` the strategy re-truncates from.
  return { env, baseline: renamedPayload }
}

function parseContentLength(header: string | null): number | undefined {
  if (header === null) return undefined
  const n = Number.parseInt(header, 10)
  return Number.isFinite(n) ? n : undefined
}

// ============================================================================
// S4 — prepareWire
// ============================================================================

/**
 * S4 last-mile: env → wire, dispatched by `targetEndpoint`.
 *   - `/chat/completions`: O10 fill + `prepareChatCompletionsRequest` (O8/O9).
 *   - `/responses`: O10 fill → `translateChatCompletionsToResponses` (+ dropped
 *     params warning, deduped on ctx) → optional `normalizeCallIds` →
 *     `prepareResponsesRequest`.
 *
 * `url` is the upstream endpoint PATH; resolving it to the full Copilot URL is
 * format-agnostic transport infrastructure (retry-transport.md §4.2). `headers`
 * is the raw outbound header set (history sanitization is a sampling concern, not
 * prepareWire's).
 *
 * **P2.2-D1 (deviation, deferred):** the `/responses` branch performs the full
 * CC→Responses structural translation — NOT the "header + body trim" that
 * retry-transport.md §3 scopes prepareWire to. It is forced here because the
 * auto-truncate strategy (retry-transport §2.2) truncates `env.body.messages`
 * assuming a CC shape, and the strategy interface `handle(error, env)` cannot
 * reach a CC-original if `env.body` were already Responses-shaped — so the
 * translation cannot move earlier (translateOut / an S3 rewrite) without first
 * giving strategies a CC-original. Idempotency (§3) still holds (pure function,
 * same env → same wire). P2.3 alternative "Option Y" (translation as an S3
 * rewrite + strategy holding CC-original) is registered in 05-progress.md.
 */
function prepareOpenAiCcWire(env: RequestEnvelope): PreparedRequest {
  // via-responses (/responses): the shared RESPONSES-leg core (C4) — CC→Responses translation + dropped-
  // params warning + normalizeCallIds + prepareResponsesRequest. Same bytes the CellAssembly's
  // OUTBOUND_LEGS[RESPONSES] builds for the via-responses/forward cells.
  if (env.targetEndpoint === ENDPOINT.RESPONSES) return prepareViaResponsesWire(env)

  if (env.targetEndpoint !== ENDPOINT.CHAT_COMPLETIONS) {
    // A `translate` decision to any leg this codec cannot yet serve (e.g. the reverse
    // `@messages` leg, wired in Phase 5) must fail LOUDLY, symmetric with the anthropic
    // side's registry-throw 500 — never silently downgrade to /chat/completions and lie
    // in observability (`setRouteInfo` already recorded outboundEndpoint/translated).
    throw new Error(
      `openai-cc codec cannot prepare wire for targetEndpoint=${env.targetEndpoint} — translation to this leg is not wired in this codec (reverse legs land in Phase 5)`,
    )
  }
  // The `/chat/completions` wire prep is the shared leg core (C3) — same bytes the CellAssembly's
  // OUTBOUND_LEGS[CHAT_COMPLETIONS] builds. `fillMaxCompletionTokens` is repeated inside it (idempotent).
  return prepareChatCompletionsWire(env)
}

/**
 * S4 observability (P2.3-S): derive the history-side effective + wire request
 * descriptors for one attempt.
 *
 * `effective` is the CC-shaped post-rewrite **logical** request (`env.body` —
 * always CC, since `translateOut` is identity), labeled as the client endpoint.
 * `wire` is the actual outbound bytes: format-specific message extraction (CC
 * `messages` vs Responses `input`) + the actual upstream endpoint label.
 *
 * **Two-track, NOT byte-for-byte with legacy on the effective track:** wire-trims
 * (O10 `max_completion_tokens` fill, header build) live in `prepareWire` and so
 * land only on `wire`, never on `env.body`/`effective` (retry-transport.md §3,
 * EffectiveRequest = "before client-specific wire mutations"). The legacy handler
 * happened to apply O10 before the pipeline, leaking it into its effectiveRequest;
 * v4 keeps it on the wire track only. The `wire` track IS equivalent (both go
 * through `prepareChatCompletionsRequest`/`prepareResponsesRequest` with O10). Do
 * NOT "fix" `effective` to include O10 — that would re-introduce the legacy leak.
 */
function sampleOpenAiCcRequest(wire: PreparedRequest, env: RequestEnvelope): RequestSample {
  // REVERSE `@messages` leg (Phase 5): env.body + wire are both Anthropic-shaped (translateOut delegated
  // to the hub), so sample the Anthropic wire (`messages`; format label `anthropic-messages`).
  if (env.targetEndpoint === ENDPOINT.MESSAGES) {
    const effBody = env.body as { model?: unknown; messages?: unknown }
    const effective: EffectiveRequest = {
      model: typeof effBody.model === "string" ? effBody.model : "",
      resolvedModel: env.model as Model | undefined,
      messages: Array.isArray(effBody.messages) ? effBody.messages : [],
      payload: env.body,
      format: ANTHROPIC_MESSAGES_ENDPOINT_TYPE,
    }
    const wireBody = wire.body as { model?: unknown; messages?: unknown }
    const wireRequest: WireRequest = {
      model: typeof wireBody.model === "string" ? wireBody.model : "",
      messages: Array.isArray(wireBody.messages) ? wireBody.messages : [],
      payload: wire.body,
      headers: Object.fromEntries(wire.headers.entries()),
      format: ANTHROPIC_MESSAGES_ENDPOINT_TYPE,
    }
    return { effective, wire: wireRequest }
  }

  // `/chat/completions` (direct + forward @cc): the shared leg sampler (C3) — same tracks the CellAssembly
  // produces. via-responses (/responses): the shared RESPONSES-leg sampler (C4) — CC effective + Responses wire.
  if (env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS) return sampleChatCompletionsWireTrack(wire, env)
  return sampleViaResponsesWireTrack(wire, env)
}

// ============================================================================
// S6 — renderResponse (streaming)
// ============================================================================

/**
 * Translate one upstream Responses SSE frame to CC chunk frame(s) via the
 * per-request closure translator. Internalizes the three loop-level behaviors
 * of the legacy `translateResponsesStream` (responses-to-cc-stream.ts) that the
 * per-frame model must reproduce:
 *   1. unparseable `data` → `[]` (try/catch — an uncaught JSON error would
 *      propagate through the driver's `async function*` and tear down the stream);
 *   2. empty / `[DONE]` data → `[]` (swallow the upstream sentinel — the
 *      via-responses `[DONE]` is re-synthesized at stream end, see P2.2-D2);
 *   3. `response.completed` → multiple chunks (finish + usage), returned as an
 *      array so the driver's `renderFrames` preserves their order.
 *
 * **P2.2-D2 (deferred):** the trailing CC `[DONE]` is NOT emitted here — the
 * legacy `translateResponsesStream` yields it unconditionally AFTER the upstream
 * loop, outside the translator, and a per-frame translator never sees "stream
 * end". P2.3 synthesizes it at the driver stream end (candidate: an S5 terminal
 * ResponseRewrite gated on `targetEndpoint === "/responses"`, reusing the driver
 * `flushChain`). Passthrough `[DONE]` arrives as an upstream frame and forwards
 * verbatim, so it is unaffected.
 */
function renderResponsesFrameToCc(frame: UpstreamFrame, translator: StreamTranslator): Array<ClientFrame> {
  if (!frame.data || frame.data === "[DONE]") return []

  let event: ResponsesStreamEvent
  try {
    event = JSON.parse(frame.data) as ResponsesStreamEvent
  } catch (err) {
    consola.debug(`[cc←responses] skipping unparseable SSE frame (${err instanceof Error ? err.message : String(err)}):`, frame.data.slice(0, 200))
    return []
  }

  return translator.translate(event).map((chunk: ChatCompletionChunk): ClientFrame => ({ data: JSON.stringify(chunk), event: "message" }))
}

// ============================================================================
// S7 — formatError
// ============================================================================

/**
 * Shape a classified stream-lifecycle error into an OpenAI SSE `error` frame.
 *
 * **P2.2-D4 (deferred):** the locked `formatError(err: ClassifiedStreamError)`
 * signature hands only the classified KIND, not the raw error — so this cannot
 * forward the raw upstream message the legacy handler does (handler.ts emits
 * `error.message = rawError.message`). The message here is kind-derived. P2.3
 * (driver S7 wiring, which holds the raw error) reconciles this across all
 * codecs — likely by passing the raw error/message into the frame.
 */
/** Kind-derived error-frame messages (see P2.2-D4 — raw message is unavailable). */
const STREAM_ERROR_MESSAGES: Record<ClassifiedStreamError, string> = {
  "idle-timeout": "Stream idle timeout",
  shutdown: "Server is shutting down",
  "client-abort": "Client disconnected",
  "reaper-cancel": "Request cancelled by stale-request reaper",
  other: "Stream error",
}

function formatOpenAiCcError(err: ClassifiedStreamError): ClientFrame {
  return { event: "error", data: JSON.stringify({ error: { message: STREAM_ERROR_MESSAGES[err], type: streamErrorKindToOpenAIErrorType(err) } }) }
}

// ============================================================================
// Envelope construction + lazy view
// ============================================================================

interface EnvelopeInit {
  targetEndpoint: UpstreamEndpoint
  routeOverride?: RouteOverride
  model: ResolvedModel
  stream: boolean
  body: unknown
  ctx: RequestContext
  prepareHints?: PrepareHints
  requestState?: RequestState
}

/**
 * Build a {@link RequestEnvelope}. `with()` rebuilds a fresh envelope from the
 * current field values + patch (shallow copy + patch); `view` is a lazy CC
 * projection re-derived from the current `body`. No shared envelope factory
 * exists yet — the codec owns construction (the next codecs add their own).
 */
function makeEnvelope(init: EnvelopeInit): RequestEnvelope {
  const env: RequestEnvelope = {
    clientFormat: CLIENT_FORMAT,
    targetEndpoint: init.targetEndpoint,
    ...(init.routeOverride && { routeOverride: init.routeOverride }),
    model: init.model,
    stream: init.stream,
    body: init.body,
    prepareHints: init.prepareHints ?? {},
    ...(init.requestState !== undefined && { requestState: init.requestState }),
    ctx: init.ctx,
    get view(): LazyMessageView {
      return createCcLazyView(env.body)
    },
    with(patch) {
      return makeEnvelope({
        targetEndpoint: env.targetEndpoint,
        routeOverride: env.routeOverride,
        model: env.model,
        stream: env.stream,
        body: env.body,
        ctx: env.ctx,
        prepareHints: env.prepareHints,
        requestState: env.requestState,
        ...patch,
      })
    },
  }
  return env
}

/**
 * Lazy, read-only neutral projection of a CC payload. **Not** a normalization IR
 * — it exposes just enough for routing / logging / gate decisions; rewrites that
 * need byte fidelity operate on `env.body` directly. Computed lazily on access.
 */
function createCcLazyView(body: unknown): LazyMessageView {
  const payload = body as ChatCompletionsPayload
  let messagesCache: ReadonlyArray<NeutralMessage> | undefined
  let toolsCache: ReadonlyArray<NeutralTool> | undefined

  const messages = (): ReadonlyArray<NeutralMessage> => (messagesCache ??= payload.messages.map((m) => projectMessage(m)))
  const tools = (): ReadonlyArray<NeutralTool> => (toolsCache ??= (payload.tools ?? []).map((t) => ({ name: t.function.name })))
  const system = (): NeutralSystem | undefined => {
    const sys = payload.messages.find((m) => m.role === "system" || m.role === "developer")
    return sys ? { text: textOf(sys.content) } : undefined
  }

  return {
    get messages() {
      return messages()
    },
    get tools() {
      return tools()
    },
    get system() {
      return system()
    },
    get summary() {
      const msgs = payload.messages
      return {
        messageCount: msgs.length,
        hasTools: (payload.tools?.length ?? 0) > 0,
        hasThinking: false, // CC has no thinking blocks
        hasImages: msgs.some((m) => messageHasImages(m)),
      }
    },
  }
}

function projectMessage(msg: Message): NeutralMessage {
  return {
    role: msg.role,
    hasThinking: false, // CC has no thinking blocks
    hasImages: messageHasImages(msg),
    toolUseCount: msg.tool_calls?.length ?? 0,
    toolResultCount: msg.role === "tool" ? 1 : 0,
  }
}

function messageHasImages(msg: Message): boolean {
  return Array.isArray(msg.content) && msg.content.some((part) => part.type === "image_url")
}

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
}
