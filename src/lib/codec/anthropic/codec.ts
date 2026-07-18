/**
 * v4 pipeline — anthropic-messages FormatCodec (P2.6 / C2).
 *
 * Anthropic /v1/messages is the "bypass direct" format for the DIRECT leg: there is
 * NO protocol translation — `translateOut` / `renderResponse` / `renderResponseNonStreaming`
 * are all identity (the upstream IS the Anthropic Messages API). A FORWARD translate leg
 * (`@cc`/`@responses`) instead delegates request + non-streaming-response translation to the
 * hub (streaming response translation is still fail-fast until Phase 4). What makes it the
 * heaviest codec is the request side: the ordered sanitize chain (tool-preprocess
 * → tool-name → sanitize, B/A steps) and the B1-B12 wire preparation, plus the 8
 * retry strategies (anthropic-strategies.ts) and the beta-probe negotiation.
 *
 * **Per-request stateful factory.** `createAnthropicCodec({ betaProbe, preprocessInfo })`
 * is built once per request. The closure holds: the RequestContext (parse-created),
 * the truncation/message-mapping baseline (preprocessed, pre-initial-sanitize), the
 * initial sanitization info, and the resanitize closure — the per-request accessors the
 * route reads to rebuild retry pipeline-info (RFC §12.4/§12.5). The OUTBOUND-side state
 * (latest effective messages, stripped cache_control subfields, outbound betas) now lives
 * on the CellAssembly leg → ctx side-channels, not this closure (RFC 2026-07-13 §11).
 *
 * **betaProbe is a cross-component handle** (RFC §2.4): the handler builds it once
 * and injects the SAME instance into both `parse` (which threads it onto `env.requestState`
 * for the anthropic-cell's `prepareWire` to record the outbound betas) and the strategies
 * (the unsupported-beta strategy reads
 * the candidates). The factory takes it as a parameter.
 *
 * Mirrors the deferred markers of openai-cc (P2.2-D*): system-prompt injection is
 * a route pre-step (parse is sync); `formatError` gets only the classified kind.
 */

import consola from "consola"

import type {
  //
  AnthropicSanitizeFn,
  BetaProbe,
} from "~/lib/anthropic/pipeline"
import type { RequestContext } from "~/lib/context/request"
import type {
  //
  EndpointType,
  PreprocessInfo,
} from "~/lib/history/types"
import type { Model } from "~/lib/models/client"
import type { CcToAnthropicStreamMeta } from "~/lib/openai/translate"
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
import type { RequestRewrite } from "~/lib/pipeline/rewrite-registry"
import type {
  //
  ClassifiedStreamError,
  ClientFrame,
  FormatCodec,
  RawHttpRequest,
  ResponseAccumulator,
} from "~/lib/pipeline/types"
import type { PrepareHints } from "~/lib/request/pipeline"
import type {
  //
  MessageParam,
  MessagesPayload,
} from "~/types/api/anthropic"

import { runAnthropicPayloadRewrites } from "~/lib/anthropic/payload-rewrites"
import {
  //
  toSanitizationInfo,
} from "~/lib/anthropic/sanitize"
import { buildAnthropicToolNameMapper } from "~/lib/anthropic/sanitize/tool-name-sanitize"
import { createAnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import { createQuarantineProactiveFilter } from "~/lib/anthropic/thinking-quarantine/proactive-filter"
import { getRequestContextManager } from "~/lib/context/manager"
import { modelIdFor, stripThinkingSignatureFor } from "~/lib/config/model-translation"
import {
  //
  captureInboundHeaders,
} from "~/lib/fetch-utils"
import {
  //
  getAgentIdFromHeaders,
  getSessionIdFromHeaders,
} from "~/lib/history/store"
import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  resolveModelTarget,
  type RouteOverride,
} from "~/lib/models/resolver"
import { createResponsesStreamAccumulator } from "~/lib/openai/responses-stream-accumulator"
import { createOpenAIStreamAccumulator } from "~/lib/openai/stream-accumulator"
import {
  //
  createForwardStreamTranslator,
  type ForwardStreamTranslator,
  renderResponseNonStreamingVia,
} from "~/lib/pipeline/hub-translate"
import { state } from "~/lib/state"
import { processAnthropicSystem } from "~/lib/system-prompt"

import { createAnthropicSanitizeRewrite } from "./request-rewrite-adapter"

const CLIENT_FORMAT: ClientFormat = "anthropic"
const ENDPOINT_TYPE: EndpointType = "anthropic-messages"

/** Sanitization-info envelope shape (the history-facing subset of SanitizationStats). */
type SanitizationInfo = ReturnType<typeof toSanitizationInfo>

/**
 * The anthropic-messages codec, widened beyond {@link FormatCodec} with the
 * per-request accessors the route/handler need to rebuild retry pipeline-info
 * (RFC §12.4) + settle the ctx on a parse-period failure.
 */
export interface AnthropicCodec extends FormatCodec {
  /** The RequestContext created by `parse` (route `c.set` + failure settle). */
  getContext(): RequestContext | undefined
  /** Truncation + message-mapping baseline: preprocessed, pre-initial-sanitize payload. */
  getTruncateBaseline(): MessagesPayload | undefined
  /** The initial sanitization-info envelope (first element of the retry `sanitization` list). */
  getInitialSanitizationInfo(): SanitizationInfo | undefined
  /** The route-supplied message-level preprocess info (for `setPipelineInfo.preprocessing`). */
  getPreprocessInfo(): PreprocessInfo | undefined
  /** The resanitize closure (= the direct sanitize chain) the strategies reuse. */
  getResanitize(): AnthropicSanitizeFn | undefined
  /** The per-request request rewrites (driver S3): the sanitize chain + its side-channel recordings (RFC §4.A0). */
  getRequestRewrites(): ReadonlyArray<RequestRewrite>
  /**
   * FORWARD translate-leg STREAMING drain (Phase 4, T4.2): the CC→Anthropic stream translator's
   * terminal frames (close the open block + message_delta + message_stop). Returns `[]` for the direct
   * leg (Anthropic upstream needs no synthesized terminator — it carries its own message_stop). The
   * owns-sink handler calls it after the `driver.runResponseSink` loop (the per-frame `renderResponse`
   * has no stream-end hook), mirroring the gemini / responses codecs.
   */
  flushResponse(env: RequestEnvelope): Array<ClientFrame>
  /**
   * FORWARD translate-leg terminal stream meta (Phase 4): the Anthropic `stop_reason` (undefined ⇒
   * truncation, F2) + net usage the CC→Anthropic translator accumulated while rendering. `renderResponse`
   * returns only frames, so this exposes the out-of-band meta the handler needs for `ctx.complete` / a
   * partial settle. Undefined for the direct leg (the direct pump reads its own Anthropic accumulator).
   */
  getStreamMeta(): CcToAnthropicStreamMeta | undefined
}

/** Args for {@link createAnthropicCodec}. */
export interface CreateAnthropicCodecArgs {
  /** The shared per-request beta probe (also injected into the strategies). */
  betaProbe: BetaProbe
  /** Message-level preprocess info computed by the route (preprocessAnthropicMessages). */
  preprocessInfo: PreprocessInfo
}

/**
 * Build the anthropic-messages codec for one request. Holds the per-request
 * baseline + ctx + resanitize closure (see module docstring).
 */
export function createAnthropicCodec(args: CreateAnthropicCodecArgs): AnthropicCodec {
  let requestContext: RequestContext | undefined
  let truncateBaseline: MessagesPayload | undefined
  let initialSanitizationInfo: SanitizationInfo | undefined
  let resanitize: AnthropicSanitizeFn | undefined

  // FORWARD translate-leg STREAMING translator (Phase 4), built lazily on the first streaming
  // `renderResponse` for a translate leg. The cc leg drives it single-hop (CC→Anthropic); the responses
  // leg drives it two-hop inside the hub (Responses→CC→Anthropic). A direct `/v1/messages` request never
  // builds it (render is identity). `flushResponse` / `getStreamMeta` read the SAME instance.
  let streamTranslator: ForwardStreamTranslator | undefined
  const ensureStreamTranslator = (env: RequestEnvelope): ForwardStreamTranslator => {
    const modelId = modelIdFor(env.model as Model | undefined, (env.body as { model?: string }).model) ?? ""
    return (streamTranslator ??= createForwardStreamTranslator(env.targetEndpoint, modelId, reasoningRoundTripOpts(env)))
  }

  // The S3 request rewrite chain, built once per request. Execution order is by
  // the sorted `.order` key (NOT array position — assembleRequestRewrites sorts):
  //   - thinking-quarantine-proactive (250): L3 strip-all for known-poisoned
  //     conversations — MUST precede sanitize so a quarantined turn has no thinking
  //     for L1 de-stack to orphan (proactive-filter.ts / RFC §3.4).
  //   - anthropic-sanitize (300): the sanitize chain + its side-channel recordings.
  // The sanitize rewrite closes over `preprocessInfo` (route-supplied, not on the env)
  // and writes the initial sanitization-info back to the closure for the retry-rebuild
  // reads. parse leaves env.body = pre-sanitize baseline; the driver's S3 runs these
  // (RFC §4.A0).
  const requestRewrites: ReadonlyArray<RequestRewrite> = [
    createQuarantineProactiveFilter(),
    createAnthropicSanitizeRewrite({
      preprocessInfo: args.preprocessInfo,
      onInitialSanitizationInfo: (info) => {
        initialSanitizationInfo = info
      },
    }),
  ]

  return {
    format: CLIENT_FORMAT,

    parse(raw) {
      const parsed = parseAnthropic(raw)
      requestContext = parsed.env.ctx
      truncateBaseline = parsed.baseline
      resanitize = parsed.resanitize
      // Attach the request-lifecycle-STABLE outbound-leg supply (RFC §11.2 / R2) so the direct
      // `/v1/messages` CellAssembly reads it from `env.requestState` instead of this codec closure
      // (C2a). Additive today: no reader until the driver's cell-keyed hybrid fork routes the direct
      // cell through the assembly (C2a.2). `initialSanitizationInfo` is a side-channel written later by
      // the sanitize rewrite → it lives on `ctx`, not here.
      return parsed.env.with({
        requestState: {
          betaProbe: args.betaProbe,
          truncateBaseline: parsed.baseline,
          resanitize: parsed.resanitize as (payload: unknown) => unknown,
          clientRequestHeaders: parsed.clientRequestHeaders,
          preprocessInfo: args.preprocessInfo,
          ...(parsed.clientAnthropicBeta !== undefined && { clientAnthropicBeta: parsed.clientAnthropicBeta }),
        },
      })
    },

    getContext() {
      return requestContext
    },

    // S1b (RFC 2026-07-14 §4): async system-prompt injection over the top-level `system` field,
    // moved off the route handler so `client.inbound` (Phase 4) sees the client-NATIVE system
    // (pre-injection). Early-returns when there is no system (mirrors the legacy route's
    // `if (wireBody.system)` guard). `env.body.model` is the resolved name (parse set it).
    async translateInbound(env) {
      const body = env.body as MessagesPayload
      if (!body.system) return env
      const system = await processAnthropicSystem(body.system, body.model, "anthropic")
      return env.with({ body: { ...body, system } })
    },

    getTruncateBaseline() {
      return truncateBaseline
    },
    getInitialSanitizationInfo() {
      return initialSanitizationInfo
    },
    getPreprocessInfo() {
      return args.preprocessInfo
    },
    getResanitize() {
      return resanitize
    },
    getRequestRewrites() {
      return requestRewrites
    },

    // S2 translateOut / S4 prepareWire / S4-sample are owned by the CellAssembly's `OUTBOUND_LEGS` for
    // every real request (direct `/v1/messages` via anthropic-cell, forward `@cc`/`@responses` via the CC
    // leg); the codec no longer implements them. The RESPONSE-side render below stays here (InboundCodec):
    // it dispatches the same `isForwardTranslateLeg` (a FORWARD leg drives the CC→Anthropic response
    // translator; the direct leg is identity).

    // S6 render (streaming): the direct path is identity. A FORWARD translate leg drives the per-request
    // CC→Anthropic STREAMING translator (Phase 4, T4.1/T4.2) — cc leg single-hop, responses leg two-hop
    // (composed inside the hub). Returns 0+ Anthropic frames per upstream frame; the terminal
    // message_delta + message_stop are drained by `flushResponse` (the per-frame render has no stream-end
    // hook, mirroring the gemini/responses codecs). The REVERSE `→ messages` streaming leg is Phase 5.
    renderResponse(frame, env) {
      if (!isForwardTranslateLeg(env.targetEndpoint)) return frame
      return ensureStreamTranslator(env).renderFrame(frame)
    },
    // S6 render (non-streaming): the direct path is identity. A FORWARD translate leg (Phase 3, T3.3)
    // delegates to the hub's CC→Anthropic response translator (`renderResponseNonStreamingVia`), turning
    // the upstream CC / Responses completion back into the Anthropic Messages response the client expects
    // — the leg is now end-to-end wired for non-streaming. A content_filter degradation (N3) is recorded
    // as a ctx marker so the wire end_turn stays observably distinguishable (richest-data-flow).
    renderResponseNonStreaming(upstream, env) {
      if (!isForwardTranslateLeg(env.targetEndpoint)) return upstream
      const { rendered, contentFiltered } = renderResponseNonStreamingVia(env.targetEndpoint, upstream, reasoningRoundTripOpts(env))
      if (contentFiltered) env.ctx.recordFeature("translated-content-filter")
      return rendered
    },

    formatError(err) {
      return formatAnthropicError(err)
    },

    // S6 streaming drain (Phase 4): a FORWARD translate leg drains the CC→Anthropic translator's terminal
    // frames (message_delta + message_stop); the direct leg has none (Anthropic upstream carries its own
    // message_stop → []). The handler writes these after the driver loop.
    flushResponse(env) {
      if (!isForwardTranslateLeg(env.targetEndpoint)) return []
      return ensureStreamTranslator(env).flush()
    },

    // S6 streaming terminal meta (Phase 4): the translate leg's out-of-band stop_reason + net usage; the
    // direct leg reads its own Anthropic accumulator → undefined here.
    getStreamMeta() {
      return streamTranslator?.getMeta()
    },

    // observability (S4 per-attempt): the OUTBOUND-leg accumulator (RFC §4.1 — accumulator is a
    // targetEndpoint-axis concern, "上游腿形"). The direct leg's upstream is Anthropic → the Anthropic
    // accumulator; a FORWARD cc leg's upstream is CC → the CC accumulator; a FORWARD responses leg's
    // upstream is Responses → the Responses accumulator (feeding an accumulator the WRONG format's frames
    // would produce a malformed/empty outboundResponse, violating richest-data-flow "后端存储必须完整").
    // The `env` param was restored in Phase 4 (RFC §4.1); Phase 0/1 dropped it when the method had zero
    // production consumers.
    createResponseAccumulator(env): ResponseAccumulator {
      if (env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS) return createOpenAIStreamAccumulator()
      if (env.targetEndpoint === ENDPOINT.RESPONSES || env.targetEndpoint === ENDPOINT.WS_RESPONSES) return createResponsesStreamAccumulator()
      return createAnthropicStreamAccumulator()
    },
  }
}

/**
 * Is the outbound leg a FORWARD translate leg (anthropic → CC / Responses)? The bypass-direct path
 * uses `/v1/messages`; an unset leg (isolated unit-test envs, before the driver's S2 overwrite) is
 * treated as direct too. Only an explicit CC / Responses leg takes the hub-delegated translate path.
 */
function isForwardTranslateLeg(targetEndpoint: UpstreamEndpoint | undefined): targetEndpoint is Exclude<UpstreamEndpoint, "/v1/messages"> {
  return targetEndpoint === ENDPOINT.CHAT_COMPLETIONS || targetEndpoint === ENDPOINT.RESPONSES || targetEndpoint === ENDPOINT.WS_RESPONSES
}

/**
 * RFC §4.3 scenario A/B (Phase 5): resolve `{ stripThinkingSignature }` for the FORWARD
 * `(anthropic client, responses model)` reasoning round-trip. Only meaningful on the RESPONSES/
 * WS_RESPONSES leg (the CC leg has no reasoning round-trip carrier concept) — the CC leg's
 * `renderResponseNonStreamingVia`/`createForwardStreamTranslator` call sites simply ignore an
 * always-`false` result, so passing it unconditionally on every forward leg is harmless (no
 * conditional call-site duplication needed).
 */
function reasoningRoundTripOpts(env: RequestEnvelope): { stripThinkingSignature: boolean } {
  const modelId = modelIdFor(env.model as Model | undefined, (env.body as { model?: string }).model)
  return { stripThinkingSignature: stripThinkingSignatureFor("anthropic-messages", modelId, "openai-responses") }
}

// ============================================================================
// S1 — parse
// ============================================================================

interface ParseAnthropicResult {
  env: RequestEnvelope
  baseline: MessagesPayload
  clientAnthropicBeta: string | undefined
  /** Client's raw inbound HTTP headers (lowercased keys), for optional upstream passthrough. */
  clientRequestHeaders: Record<string, string>
  resanitize: AnthropicSanitizeFn
}

/**
 * S1: inbound HTTP → envelope. **Synchronous** (FormatCodec.parse contract).
 *
 * Reproduces the request-side ctx setup (ctx create → setOriginalRequest →
 * tool-name mapper → setResolvedModel) + the resanitize closure. The initial
 * sanitize pass and its pipeline-info / message-mapping / thinking recordings move
 * to driver S3 (`createAnthropicSanitizeRewrite`, RFC §4.A0) — parse leaves
 * `env.body` = the pre-sanitize baseline. The route pre-step has already done warmup /
 * model resolve / async system-prompt / message-level `preprocessAnthropicMessages` /
 * web_search — so `raw.body` is the preprocessed + system-injected wire body, and
 * `raw.originalBodyForHistory` is the client's raw pre-injection body.
 */
function parseAnthropic(raw: RawHttpRequest): ParseAnthropicResult {
  const incoming = raw.body as MessagesPayload
  const clientBody = (raw.originalBodyForHistory ?? raw.body) as MessagesPayload
  const originalSnapshot = structuredClone(clientBody)

  const clientModel = raw.modelOverride ?? incoming.model
  const resolvedTarget = raw.preResolved ?? resolveModelTarget(clientModel)
  const resolvedName = resolvedTarget.name
  const routeOverride = resolvedTarget.routeOverride
  if (resolvedName !== clientModel) consola.debug(`Model name resolved: ${clientModel} → ${resolvedName}`)
  const selectedModel = raw.preResolved ? raw.preResolved.model : state.modelIndex.get(resolvedName)
  const clientModelName = clientModel !== resolvedName ? clientModel : undefined

  // The model-resolved payload (messages already preprocessed by the route). This
  // is the truncation + message-mapping baseline: preprocessed, pre-initial-sanitize.
  const anthropicPayload: MessagesPayload = { ...incoming, model: resolvedName }

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
    model: clientModelName ?? originalSnapshot.model,
    messages: originalSnapshot.messages as unknown as Array<unknown>,
    stream: originalSnapshot.stream ?? false,
    tools: originalSnapshot.tools as unknown as Array<unknown> | undefined,
    system: originalSnapshot.system,
    payload: originalSnapshot,
  })
  ctx.setInboundRequestHeaders(captureInboundHeaders(raw.headers))
  ctx.recordModelOperationIngress()

  // Tool-name mapper from the client's ORIGINAL tools (preprocess does not touch
  // tools, so `incoming.tools` is still the client's set). Stored on ctx so the
  // response-side restore reverses it.
  const toolNameMapper = buildAnthropicToolNameMapper(incoming.tools, resolvedName, selectedModel?.vendor)
  ctx.setToolNameMapper(toolNameMapper)

  ctx.setResolvedModel({
    resolved: resolvedName,
    ...(clientModelName !== undefined && { client: clientModelName }),
  })

  // The direct sanitize chain — reused as the adapter's sanitize and auto-truncate's
  // resanitize (the strategies read it via codec.getResanitize()). The INITIAL pass
  // (+ its pipelineInfo / messageMapping / thinking / initialSanitizationInfo
  // recordings) now runs in driver S3 via `createAnthropicSanitizeRewrite` (RFC §4.A0),
  // NOT here — so a model rejected at S2 never sanitizes, and env.body below stays the
  // pre-sanitize baseline (= the truncation/message-mapping baseline) until S3.
  const resanitize: AnthropicSanitizeFn = (p) => runAnthropicPayloadRewrites(p, { toolNameMapper }).sanitizeResult

  const env = makeEnvelope({
    targetEndpoint: ENDPOINT.MESSAGES,
    ...(routeOverride && { routeOverride }),
    model: selectedModel as ResolvedModel,
    stream: anthropicPayload.stream ?? false,
    body: anthropicPayload,
    ctx,
  })

  return {
    env,
    baseline: anthropicPayload,
    clientAnthropicBeta: raw.headers.get("anthropic-beta") ?? undefined,
    // Capture the client's raw headers (Headers.entries() yields lowercased keys)
    // for optional passthrough. Taken straight from raw.headers — NOT the ctx
    // inbound copy — to stay decoupled from the History sanitization policy.
    clientRequestHeaders: Object.fromEntries(raw.headers.entries()),
    resanitize,
  }
}

function parseContentLength(header: string | null): number | undefined {
  if (header === null) return undefined
  const n = Number.parseInt(header, 10)
  return Number.isFinite(n) ? n : undefined
}

// ============================================================================
// S7 — formatError
// ============================================================================

/** Kind-derived error-frame messages (raw upstream message unavailable — see P2.2-D4). */
const STREAM_ERROR_MESSAGES: Record<ClassifiedStreamError, string> = {
  "idle-timeout": "Stream idle timeout",
  shutdown: "Server is shutting down",
  "client-abort": "Client disconnected",
  "reaper-cancel": "Request cancelled by stale-request reaper",
  other: "Stream error",
}

/** Map the classified kind to Anthropic's error `type` (mirrors legacy anthropicStreamErrorType). */
function anthropicErrorType(err: ClassifiedStreamError): string {
  switch (err) {
    case "idle-timeout": {
      return "timeout_error"
    }
    case "shutdown":
    case "reaper-cancel": {
      return "overloaded_error"
    }
    default: {
      return "api_error"
    } // client-abort + other
  }
}

/**
 * Shape a classified stream-lifecycle error into an Anthropic SSE `error` frame.
 * Anthropic's frame is double-typed: `{ type: "error", error: { type, message } }`
 * (distinct from OpenAI's `{ error: { message, type } }`). The handler builds the
 * mid-stream error frame inline with the raw message; this is the codec's fallback.
 */
function formatAnthropicError(err: ClassifiedStreamError): ClientFrame {
  return { event: "error", data: JSON.stringify({ type: "error", error: { type: anthropicErrorType(err), message: STREAM_ERROR_MESSAGES[err] } }) }
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

/** Build a {@link RequestEnvelope}; `with()` shallow-copies + patches, `view` is a lazy Anthropic projection. */
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
      return createAnthropicLazyView(env.body)
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

/** Block-type discriminant for the lazy projection (Anthropic content blocks). */
interface ContentBlockLike {
  type?: string
}

/**
 * Lazy, read-only neutral projection of an Anthropic payload. Exposes just enough
 * for routing / logging / gate decisions; rewrites that need byte fidelity operate
 * on `env.body` directly. Computed lazily on access.
 */
function createAnthropicLazyView(body: unknown): LazyMessageView {
  const payload = body as MessagesPayload
  let messagesCache: ReadonlyArray<NeutralMessage> | undefined
  let toolsCache: ReadonlyArray<NeutralTool> | undefined

  const messages = (): ReadonlyArray<NeutralMessage> => (messagesCache ??= payload.messages.map((m) => projectMessage(m)))
  const tools = (): ReadonlyArray<NeutralTool> => (toolsCache ??= (payload.tools ?? []).map((t) => ({ name: (t as { name: string }).name })))
  const system = (): NeutralSystem | undefined => {
    if (payload.system === undefined) return undefined
    return { text: systemText(payload.system) }
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
        hasThinking: msgs.some((m) => messageHasThinking(m)),
        hasImages: msgs.some((m) => messageHasImages(m)),
      }
    },
  }
}

function blocksOf(msg: MessageParam): Array<ContentBlockLike> {
  return Array.isArray(msg.content) ? (msg.content as Array<ContentBlockLike>) : []
}

function projectMessage(msg: MessageParam): NeutralMessage {
  const blocks = blocksOf(msg)
  return {
    role: msg.role,
    hasThinking: blocks.some((b) => b.type === "thinking" || b.type === "redacted_thinking"),
    hasImages: blocks.some((b) => b.type === "image"),
    toolUseCount: blocks.filter((b) => b.type === "tool_use").length,
    toolResultCount: blocks.filter((b) => b.type === "tool_result").length,
  }
}

function messageHasThinking(msg: MessageParam): boolean {
  return blocksOf(msg).some((b) => b.type === "thinking" || b.type === "redacted_thinking")
}

function messageHasImages(msg: MessageParam): boolean {
  return blocksOf(msg).some((b) => b.type === "image")
}

function systemText(system: MessagesPayload["system"]): string {
  if (typeof system === "string") return system
  if (!Array.isArray(system)) return ""
  return system
    .filter((part): part is { type: "text"; text: string } => (part as ContentBlockLike).type === "text")
    .map((part) => part.text)
    .join("")
}
