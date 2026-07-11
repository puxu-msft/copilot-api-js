/**
 * v4 pipeline — anthropic-messages FormatCodec (P2.6 / C2).
 *
 * Anthropic /v1/messages is the "bypass direct" format: there is NO protocol
 * translation — `translateOut` / `renderResponse` / `renderResponseNonStreaming`
 * are all identity (the upstream IS the Anthropic Messages API). What makes it the
 * heaviest codec is the request side: the ordered sanitize chain (tool-preprocess
 * → tool-name → sanitize, B/A steps) and the B1-B12 wire preparation, plus the 8
 * retry strategies (anthropic-strategies.ts) and the beta-probe negotiation.
 *
 * **Per-request stateful factory.** `createAnthropicCodec({ betaProbe, preprocessInfo })`
 * is built once per request. The closure holds: the RequestContext (parse-created),
 * the truncation/message-mapping baseline (preprocessed, pre-initial-sanitize), the
 * client `anthropic-beta` header, the initial sanitization info, the resanitize
 * closure, and the latest effective messages/thinking (updated by `sampleRequest`,
 * read by the route to rebuild retry pipeline-info — RFC §12.4/§12.5).
 *
 * **betaProbe is a cross-component handle** (RFC §2.4): the handler builds it once
 * and injects the SAME instance into both this codec (which records the outbound
 * betas in `prepareWire`) and the strategies (the unsupported-beta strategy reads
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
  EffectiveRequest,
  WireRequest,
} from "~/lib/context/types"
import type {
  //
  EndpointType,
  PreprocessInfo,
} from "~/lib/history/types"
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
import type { RequestRewrite } from "~/lib/pipeline/rewrite-registry"
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
} from "~/lib/pipeline/types"
import type { PrepareHints } from "~/lib/request/pipeline"
import type {
  //
  MessageParam,
  MessagesPayload,
} from "~/types/api/anthropic"

import {
  //
  autoTruncateAnthropic,
  countTotalTokens,
} from "~/lib/anthropic/auto-truncate"
import { calculateTokenLimit } from "~/lib/anthropic/auto-truncate/truncation"
import { supportsDirectAnthropicApi } from "~/lib/anthropic/features"
import { runAnthropicPayloadRewrites } from "~/lib/anthropic/payload-rewrites"
import { prepareAnthropicRequest } from "~/lib/anthropic/request-preparation"
import {
  //
  toSanitizationInfo,
} from "~/lib/anthropic/sanitize"
import { buildAnthropicToolNameMapper } from "~/lib/anthropic/sanitize/tool-name-sanitize"
import { createAnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import { createQuarantineProactiveFilter } from "~/lib/anthropic/thinking-quarantine/proactive-filter"
import {
  //
  DEFAULT_AUTO_TRUNCATE_CONFIG,
  factorAt,
} from "~/lib/auto-truncate"
import { getRequestContextManager } from "~/lib/context/manager"
import {
  //
  captureInboundHeaders,
  sanitizeHeadersForHistory,
} from "~/lib/fetch-utils"
import {
  //
  getAgentIdFromHeaders,
  getSessionIdFromHeaders,
} from "~/lib/history/store"
import { ENDPOINT } from "~/lib/models/endpoint"
import { resolveModelName } from "~/lib/models/resolver"
import { state } from "~/lib/state"

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
  /** Latest attempt's effective `messages` (sampleRequest-captured; message-mapping rebuild). */
  getLatestEffectiveMessages(): Array<unknown> | undefined
  /** The per-request request rewrites (driver S3): the sanitize chain + its side-channel recordings (RFC §4.A0). */
  getRequestRewrites(): ReadonlyArray<RequestRewrite>
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
  let clientAnthropicBeta: string | undefined
  let clientRequestHeaders: Record<string, string> | undefined
  let initialSanitizationInfo: SanitizationInfo | undefined
  let resanitize: AnthropicSanitizeFn | undefined
  let latestEffectiveMessages: Array<unknown> | undefined

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
      clientAnthropicBeta = parsed.clientAnthropicBeta
      clientRequestHeaders = parsed.clientRequestHeaders
      resanitize = parsed.resanitize
      return parsed.env
    },

    getContext() {
      return requestContext
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
    getLatestEffectiveMessages() {
      return latestEffectiveMessages
    },
    getRequestRewrites() {
      return requestRewrites
    },

    decideRoute(env) {
      return decideAnthropicRoute(env)
    },

    // S2/S6 are identity — Anthropic is a bypass-direct format (no translation).
    translateOut(env) {
      return env
    },
    renderResponse(frame) {
      return frame
    },
    renderResponseNonStreaming(upstream) {
      return upstream
    },

    prepareWire(env) {
      return prepareAnthropicWire(env, {
        betaProbe: args.betaProbe,
        clientAnthropicBeta,
        clientRequestHeaders,
        requestContext,
        // requested = the client's original thinking type, from the FIXED truncate
        // baseline (never the per-attempt env.body, which legacy-thinking-retry
        // mutates enabled→adaptive on retry).
        requestedThinkingType: (truncateBaseline?.thinking as { type?: string } | undefined)?.type,
      })
    },

    preSend(env) {
      return anthropicPreSend(env)
    },

    sampleRequest(wire, env): RequestSample {
      const sample = sampleAnthropicRequest(wire, env)
      latestEffectiveMessages = sample.effectiveMessages
      return sample.requestSample
    },

    formatError(err) {
      return formatAnthropicError(err)
    },

    createResponseAccumulator(): ResponseAccumulator {
      return createAnthropicStreamAccumulator()
    },
  }
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
  const resolvedName = raw.preResolved?.name ?? resolveModelName(clientModel)
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
// S2 — decideRoute
// ============================================================================

/**
 * S2: passthrough `/v1/messages` or reject 400 — NO translate/fallback (the
 * bypass-direct Anthropic endpoint has no downgrade path, RFC §2.2 / messages:167).
 */
function decideAnthropicRoute(env: RequestEnvelope): RouteDecision {
  const id = (env.model as Model | undefined)?.id ?? (env.body as MessagesPayload).model
  const decision = supportsDirectAnthropicApi(id)
  if (!decision.supported) {
    return { kind: "reject", status: 400, reason: `Model "${id}" does not support /v1/messages: ${decision.reason}` }
  }
  return { kind: "passthrough", endpoint: ENDPOINT.MESSAGES }
}

// ============================================================================
// S4 — prepareWire
// ============================================================================

interface PrepareWireDeps {
  betaProbe: BetaProbe
  clientAnthropicBeta: string | undefined
  /** Client's raw inbound headers (lowercased) for optional upstream passthrough. */
  clientRequestHeaders: Record<string, string> | undefined
  requestContext: RequestContext | undefined
  /**
   * Client's original `thinking.type` (fixed across retries — from the truncate
   * baseline, NOT `env.body` which retries mutate). Recorded as the `requested`
   * half of the merged `thinking` feature alongside the effective wire value.
   */
  requestedThinkingType: string | undefined
}

/**
 * S4 last-mile: env → wire via `prepareAnthropicRequest` (B1-B12 — wire payload +
 * reject/server-tool strip + coerce-thinking + clamp-effort + cache-control +
 * headers). Records the outbound betas on the probe (replacing the legacy adapter's
 * `onPrepared`) + surfaces the actual wire `thinking` shape as a feature.
 *
 * Idempotent (RFC §3): `prepareAnthropicRequest` deep-clones and does not write
 * back to `env.body`, so the same env → the same wire.
 */
function prepareAnthropicWire(env: RequestEnvelope, deps: PrepareWireDeps): PreparedRequest {
  const model = env.model as Model | undefined
  const prepared = prepareAnthropicRequest(env.body as MessagesPayload, {
    ...(model && { resolvedModel: model }),
    ...(deps.clientAnthropicBeta !== undefined && { clientAnthropicBeta: deps.clientAnthropicBeta }),
    ...(deps.clientRequestHeaders !== undefined && { clientRequestHeaders: deps.clientRequestHeaders }),
    ...(env.prepareHints.excludeBetas && { excludeBetas: env.prepareHints.excludeBetas }),
    ...(env.prepareHints.rejectFields && { rejectFields: env.prepareHints.rejectFields }),
    ...(env.prepareHints.excludeServerToolTypes && { excludeServerToolTypes: env.prepareHints.excludeServerToolTypes }),
    ...(env.prepareHints.excludeToolFields && { excludeToolFields: env.prepareHints.excludeToolFields }),
    ...(env.prepareHints.contextEscalation && { contextEscalation: env.prepareHints.contextEscalation }),
  })

  // Record the betas actually sent (sanitized headers — same value the legacy
  // adapter's onPrepared received) so unsupported-beta can probe them.
  deps.betaProbe.recordOutbound(sanitizeHeadersForHistory(prepared.headers))

  // Record `thinking` as a per-request terminal dimension: `effective` = the
  // ACTUAL outbound wire shape (post coerceAdaptiveThinking), `requested` = the
  // client's original type (fixed baseline, supplied by the codec). The console
  // overwrites `effective` per attempt and renders requested→effective once, so
  // a coercion stays visible even when a retry rewrites the body.
  const wireThinking = prepared.wire.thinking as { type?: string } | undefined
  if (wireThinking?.type && wireThinking.type !== "disabled") {
    deps.requestContext?.recordFeature("thinking", {
      ...(deps.requestedThinkingType !== undefined && { requested: deps.requestedThinkingType }),
      effective: wireThinking.type,
    })
  }

  return {
    url: ENDPOINT.MESSAGES,
    headers: new Headers(prepared.headers),
    body: prepared.wire,
    stream: (prepared.wire.stream as boolean | undefined) ?? false,
  }
}

// ============================================================================
// S4 — preSend (main-path pre-flight truncation)
// ============================================================================

/**
 * First-attempt pre-send hook (size-aware calibration §7). When
 * `state.autoTruncatePreflight` is ON, predict the request's ANTHROPIC-caliber size
 * = `est * factorAt` (est is the gpt-tokenizer count) and, if it exceeds the model's
 * limit, pre-truncate BEFORE the initial send so the necessarily-doomed 400 →
 * reactive-retry round-trip is skipped. OFF (the default) → strict no-op.
 *
 * Caliber invariant: `countTotalTokens` / the truncation engine's internal counts are
 * gpt caliber, but `learned.tokenLimit` / the predicted size are anthropic caliber. So
 * the exceed test runs in anthropic caliber (`predicted` vs `limit`), while the target
 * handed to `autoTruncateAnthropic` MUST be converted back to gpt caliber
 * (`floor(limit / factor)`) — otherwise the (much larger) anthropic limit sits above
 * the gpt token count and the engine under-truncates ("everything fits").
 */
async function anthropicPreSend(env: RequestEnvelope): Promise<RequestEnvelope> {
  if (!state.autoTruncatePreflight) return env

  // Pre-flight is an OPTIMIZATION (skip the necessarily-doomed 400 → reactive-retry
  // round-trip), NOT a correctness gate: the reactive truncation strategy stays as
  // the fallback (spec §7). So any error in the predict/truncate path must DEGRADE
  // to "send unchanged" — never become a new hard-failure surface — while still
  // being logged (not silently swallowed) so a systematic pre-flight fault is visible.
  try {
    const model = env.model
    const body = env.body as MessagesPayload

    const est = await countTotalTokens(body, model)
    const factor = factorAt(model.id, est)
    const predicted = Math.ceil(est * factor)
    const limit = calculateTokenLimit(model, DEFAULT_AUTO_TRUNCATE_CONFIG)
    // No resolvable limit (unlearned + no capability limit) or the prediction fits →
    // let the request through unchanged; the reactive retry still catches a real 400.
    if (limit === undefined || predicted <= limit) return env

    const targetGpt = Math.floor(limit / factor)
    const truncated = await autoTruncateAnthropic(body, model, { targetTokenLimit: targetGpt })
    return truncated.wasTruncated ? env.with({ body: truncated.payload }) : env
  } catch (err) {
    consola.warn("[preflight] skipped due to error, falling back to reactive truncation:", err)
    return env
  }
}

// ============================================================================
// S4 — sampleRequest (two-track observability)
// ============================================================================

interface SampleAnthropicResult {
  requestSample: RequestSample
  effectiveMessages: Array<unknown>
}

/**
 * S4 observability (P2.3-S): the two history tracks. Both are `anthropic-messages`
 * format (translateOut is identity, so env.body stays Anthropic-shaped):
 *   - `effective` = the post-rewrite logical request (`env.body`).
 *   - `wire` = the actual outbound bytes (`prepared.wire`, B1-B12 + sanitized headers).
 *
 * Captures the latest effective `messages` for the route to rebuild retry
 * message-mapping (RFC §12.4/§12.5). The §12.5 invariant
 * (`action.env.body === action.payload`) makes these the same objects the legacy
 * `recordRetryPipelineState` reads from `newPayload`.
 */
function sampleAnthropicRequest(wire: PreparedRequest, env: RequestEnvelope): SampleAnthropicResult {
  const effBody = env.body as MessagesPayload
  const effectiveMessages: Array<unknown> = Array.isArray(effBody.messages) ? effBody.messages : []

  const effective: EffectiveRequest = {
    model: typeof effBody.model === "string" ? effBody.model : "",
    resolvedModel: env.model as Model | undefined,
    messages: effectiveMessages,
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

  return { requestSample: { effective, wire: wireRequest }, effectiveMessages }
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
  model: ResolvedModel
  stream: boolean
  body: unknown
  ctx: RequestContext
  prepareHints?: PrepareHints
}

/** Build a {@link RequestEnvelope}; `with()` shallow-copies + patches, `view` is a lazy Anthropic projection. */
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
      return createAnthropicLazyView(env.body)
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
