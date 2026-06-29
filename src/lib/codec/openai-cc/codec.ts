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

import type { RequestContext } from "~/lib/context/request"
import type {
  //
  EffectiveRequest,
  WireRequest,
} from "~/lib/context/types"
import type { EndpointType } from "~/lib/history/store"
import type { Model } from "~/lib/models/client"
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
import type {
  //
  ClassifiedStreamError,
  ClientFrame,
  FormatCodec,
  PreparedRequest,
  RawHttpRequest,
  RequestSample,
  ResponseAccumulator,
  RouteDecision,
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
  ResponsesInputItem,
  ResponsesResponse,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

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
  isEndpointSupported,
  isResponsesSupported,
} from "~/lib/models/endpoint"
import { resolveModelName } from "~/lib/models/resolver"
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
  translateChatCompletionsToResponses,
  translateResponsesResponseToCC,
} from "~/lib/openai/translate"
import { state } from "~/lib/state"

const CLIENT_FORMAT: ClientFormat = "openai-cc"
const ENDPOINT_TYPE: EndpointType = "openai-chat-completions"
/** History `format` label for the via-responses wire (the actual upstream endpoint). */
const RESPONSES_ENDPOINT_TYPE: EndpointType = "openai-responses"
const DROPPED_CC_PARAMS_WARNING_CODE = "cc_to_responses_dropped_params"

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
}

/**
 * Build the openai-cc codec for one request. The returned instance holds the
 * per-request Responses→CC translator + truncation baseline in its closure (see
 * module docstring).
 */
export function createOpenAiCcCodec(): OpenAiCcCodec {
  // Lazily created on the first via-responses frame; persists across frames so
  // its cross-frame state (tool-call index map, response id) survives.
  let streamTranslator: StreamTranslator | null = null
  // The auto-truncate baseline, captured by parse (see OpenAiCcCodec).
  let truncateBaseline: ChatCompletionsPayload | undefined
  // The RequestContext created by parse (for route-side c.set + failure settle).
  let requestContext: RequestContext | undefined

  return {
    format: CLIENT_FORMAT,

    parse(raw) {
      const { env, baseline } = parseOpenAiCc(raw)
      truncateBaseline = baseline
      requestContext = env.ctx
      return env
    },

    getTruncateBaseline() {
      return truncateBaseline
    },

    getContext() {
      return requestContext
    },

    decideRoute(env) {
      return decideOpenAiCcRoute(env.model)
    },

    // S2 translateOut is identity: the CC→Responses translation is NOT done here
    // (it lives in prepareWire — see P2.2-D1 / `prepareWire`). Keeping it identity
    // means `env.body` stays CC-shaped through S3, which the CC-format request
    // rewrites and the auto-truncate strategy both rely on.
    translateOut(env) {
      return env
    },

    prepareWire(env) {
      return prepareOpenAiCcWire(env)
    },

    renderResponse(frame, env) {
      // Passthrough (/chat/completions): forward the upstream CC frame verbatim.
      if (env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS) return frame
      // via-responses (/responses): translate each Responses SSE frame → CC chunk(s).
      streamTranslator ??= createStreamTranslator({ includeUsage: includeUsageOf(env.body) })
      return renderResponsesFrameToCc(frame, streamTranslator)
    },

    renderResponseNonStreaming(upstream, env) {
      if (env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS) return upstream
      return translateResponsesResponseToCC(upstream as ResponsesResponse)
    },

    formatError(err, _env) {
      return formatOpenAiCcError(err)
    },

    createResponseAccumulator(): ResponseAccumulator {
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
  const resolvedName = raw.preResolved?.name ?? resolveModelName(clientModel)
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
    ...(raw.query !== undefined && { query: raw.query }),
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
    targetEndpoint: ENDPOINT.CHAT_COMPLETIONS, // initial; the driver overwrites via decideRoute
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
// S2 — decideRoute
// ============================================================================

/**
 * S2: passthrough / translate / reject (docs/v4/03-spec/codec.md §2).
 *   - `isEndpointSupported(/chat/completions)` → passthrough
 *   - elif `isResponsesSupported`             → translate `/responses`
 *   - else                                    → reject 400
 *
 * Non-uniform default (preserved): `isEndpointSupported` treats a model with no
 * `supported_endpoints` as supporting everything (legacy fallback) — so unknown
 * gpt-* models passthrough to /chat/completions.
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
  const model = env.model as Model | undefined
  const ccPayload = fillMaxCompletionTokens(env.body as ChatCompletionsPayload, model)

  if (env.targetEndpoint === ENDPOINT.RESPONSES) {
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

  const prepared = prepareChatCompletionsRequest(ccPayload, { resolvedModel: model })
  return {
    url: ENDPOINT.CHAT_COMPLETIONS,
    headers: new Headers(prepared.headers),
    body: prepared.wire,
    stream: prepared.wire.stream ?? false,
  }
}

/**
 * Record the "CC→Responses dropped unsupported params" warning on the context,
 * deduped by code+message (prepareWire runs per-attempt; without the dedup each
 * retry would re-warn). Mirrors the legacy handler's `warningMessages.some(...)`.
 */
function recordDroppedCcParamsWarning(ctx: RequestContext, model: string, droppedParams: Array<string>): void {
  const message = `Chat Completions -> Responses translation dropped unsupported params: ${droppedParams.join(", ")}`
  const alreadyRecorded = ctx.warningMessages.some((w) => w.code === DROPPED_CC_PARAMS_WARNING_CODE && w.message === message)
  if (alreadyRecorded) return

  consola.warn(`[CC→Responses] model=${model} ${message}`)
  ctx.addWarningMessage({ code: DROPPED_CC_PARAMS_WARNING_CODE, message })
  ctx.recordFeature("dropped-params")
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
  const effBody = env.body as { model?: unknown; messages?: unknown }
  const effective: EffectiveRequest = {
    model: typeof effBody.model === "string" ? effBody.model : "",
    resolvedModel: env.model as Model | undefined,
    messages: Array.isArray(effBody.messages) ? effBody.messages : [],
    payload: env.body,
    format: ENDPOINT_TYPE,
  }

  const wireBody = wire.body as { model?: unknown; messages?: unknown; input?: string | Array<ResponsesInputItem> }
  const isResponses = env.targetEndpoint === ENDPOINT.RESPONSES
  let wireMessages: Array<unknown>
  if (isResponses) wireMessages = extractInputItems(wireBody.input ?? [])
  else wireMessages = Array.isArray(wireBody.messages) ? wireBody.messages : []
  const wireRequest: WireRequest = {
    model: typeof wireBody.model === "string" ? wireBody.model : "",
    messages: wireMessages,
    payload: wire.body,
    headers: Object.fromEntries(wire.headers.entries()),
    format: isResponses ? RESPONSES_ENDPOINT_TYPE : ENDPOINT_TYPE,
  }

  return { effective, wire: wireRequest }
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

function includeUsageOf(body: unknown): boolean {
  return (body as ChatCompletionsPayload).stream_options?.include_usage ?? false
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
  model: ResolvedModel
  stream: boolean
  body: unknown
  ctx: RequestContext
  prepareHints?: PrepareHints
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
    model: init.model,
    stream: init.stream,
    body: init.body,
    prepareHints: init.prepareHints ?? {},
    ctx: init.ctx,
    get view(): LazyMessageView {
      return createCcLazyView(env.body)
    },
    with(patch) {
      return makeEnvelope({
        targetEndpoint: env.targetEndpoint,
        model: env.model,
        stream: env.stream,
        body: env.body,
        ctx: env.ctx,
        prepareHints: env.prepareHints,
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
