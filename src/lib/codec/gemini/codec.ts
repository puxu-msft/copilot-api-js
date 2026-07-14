/**
 * v4 pipeline — gemini FormatCodec (P2.5).
 *
 * Google Gemini is a thin translation layer over the Chat Completions path: the
 * inbound Gemini request is translated to a CC payload, the CC-payload S2–S6
 * (route decision incl. via-responses, wire prep, response normalization, request
 * sampling) is **delegated to an internal openai-cc codec**, and only the
 * "Gemini ↔ CC" shell is Gemini-specific:
 *   - `parse`: Gemini→CC translation + a Gemini-flavored RequestContext
 *     (endpoint `gemini-generate-content`, the raw Gemini snapshot as the original
 *     request) — NOT delegated, because the ctx shape + endpoint differ from CC and
 *     Gemini fills O10 (`max_completion_tokens`) in parse (matching the legacy
 *     `prepareGeminiRequest`), where the CC codec defers it to prepareWire.
 *   - `formatError`: Gemini gRPC-shape error (the handler builds the data-only
 *     error frame inline, so this is mostly for completeness).
 *
 * **renderResponse produces Gemini frames** (Stage B B5 owns-sink): the per-request
 * {@link createGeminiStreamTranslator} state machine (tool-call pairing + usage/finishReason meta),
 * formerly a whole-stream generator the handler wrapped, now lives in the codec — `renderResponse`
 * normalizes the upstream to CC (delegating to the cc codec, which also covers the via-responses
 * Responses→CC leg) then translates each CC frame → Gemini frame(s); `flushResponse` drains the
 * stream-end frames (remaining tool calls + the terminal finishReason/usage frame); `getStreamMeta`
 * exposes the terminal meta out-of-band (the owns-sink driver writes only frames). The non-streaming
 * path (`renderResponseNonStreaming`) stays CC — its handler does its own `convertOpenAIResponseToGemini`.
 * This realizes codec.md §3's "Gemini codec 委托 openai-cc 处理 CC payload" with the render shell
 * now IN the codec (B5) rather than the handler.
 *
 * **Per-request stateful factory.** `createGeminiCodec()` holds the internal
 * cc codec instance (whose closure carries the via-responses Responses→CC stream
 * translator) + the Gemini ctx + the auto-truncate baseline.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type { RequestContext } from "~/lib/context/request"
import type { GeminiStreamMeta } from "~/lib/gemini"
import type { MessageContent } from "~/lib/history"
import type { EndpointType } from "~/lib/history/store"
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
  RawHttpRequest,
  ResponseAccumulator,
} from "~/lib/pipeline/types"
import type { PrepareHints } from "~/lib/request/pipeline"
import type {
  //
  Content as GeminiContent,
  GenerateContentRequest,
  Part as GeminiPart,
} from "~/types/api/gemini"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import {
  //
  createOpenAiCcCodec,
  type OpenAiCcCodec,
} from "~/lib/codec/openai-cc/codec"
import { getRequestContextManager } from "~/lib/context/manager"
import { captureInboundHeaders } from "~/lib/fetch-utils"
import {
  //
  convertGeminiRequestToOpenAI,
  createGeminiStreamTranslator,
} from "~/lib/gemini"
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
import { fillMaxCompletionTokens } from "~/lib/openai/request-preparation"
import { sanitizeOpenAIMessages } from "~/lib/openai/sanitize"
import { state } from "~/lib/state"

const CLIENT_FORMAT: ClientFormat = "gemini"
const ENDPOINT_TYPE: EndpointType = "gemini-generate-content"
const DROPPED_GEMINI_PARAMS_WARNING_CODE = "gemini_dropped_params"

/**
 * The gemini codec, widened beyond {@link FormatCodec} with the per-request
 * context + truncation baseline accessors (the driver consumes it as a plain
 * `FormatCodec`; the handler reads the extras + the captured Gemini model id).
 */
export interface GeminiCodec extends FormatCodec {
  /** The RequestContext created by `parse` (route `c.set` + failure settle). `undefined` before parse. */
  getContext(): RequestContext | undefined
  /** The auto-truncate baseline: the post-system-prompt, pre-sanitize CC payload. `undefined` before parse. */
  getTruncateBaseline(): ChatCompletionsPayload | undefined
  /**
   * Stream-end drain (Stage B B5): the CC→Gemini translator's remaining accumulated tool calls +
   * the terminal `finishReason`/`usageMetadata` frame. The owns-sink handler writes these after the
   * driver loop (mirrors the Responses fallback `flushResponse`). Empty until `renderResponse` has run.
   */
  flushResponse(env: RequestEnvelope): Array<ClientFrame>
  /**
   * The terminal Gemini stream meta (usage + finishReason) the codec's CC→Gemini translator
   * accumulated while rendering (B5). `renderResponse` returns only frames, so this exposes the
   * out-of-band meta the handler needs for `ctx.complete` / a partial settle on error.
   */
  getStreamMeta(): GeminiStreamMeta
}

/** Args for {@link createGeminiCodec}. */
export interface CreateGeminiCodecArgs {
  /**
   * REVERSE `@messages` leg only: the shared per-request beta probe, threaded to the internal cc
   * delegate so its `prepareWire` records the outbound Anthropic betas. Absent for the direct/via-responses
   * Gemini legs.
   */
  reverseBetaProbe?: import("~/lib/anthropic/pipeline").BetaProbe
  /**
   * REVERSE `@messages` leg only: the shared per-request mapper holder. `parse` threads it onto
   * `env.requestState` so the `OUTBOUND_LEGS[/v1/messages]` reverse branch (C2b) reads the SAME instance.
   * Absent for the direct/via-responses Gemini legs.
   */
  reverseMapperHolder?: import("~/lib/codec/openai-cc/reverse-anthropic-rewrite").ReverseAnthropicMapperHolder
}

/** Build the gemini codec for one request (holds the internal cc codec + Gemini ctx). */
export function createGeminiCodec(modelId: string, opts?: CreateGeminiCodecArgs): GeminiCodec {
  // Internal delegate: the openai-cc codec drives the CC-payload S2–S6 (route
  // decision incl. via-responses, wire prep, response normalization, sampling).
  // We call its methods WITHOUT its `parse` — they are pure over `env` (+ its own
  // lazily-built via-responses translator closure), so they work standalone. The
  // REVERSE `@messages` leg (Phase 5) delegates translateOut/prepareWire/renderResponse
  // to it too: the cc delegate's MESSAGES-leg wiring (T5.2) gives gemini Anthropic→CC
  // for free (hub-and-spoke), and gemini adds the CC→Gemini second hop in renderResponse.
  const cc: OpenAiCcCodec = createOpenAiCcCodec(opts?.reverseBetaProbe ? { reverseBetaProbe: opts.reverseBetaProbe } : undefined)
  // Per-request CC→Gemini stream translator (B5): renderResponse drives it per-frame, flushResponse
  // drains the stream-end frames, getStreamMeta exposes the terminal usage/finishReason. Eager (cheap;
  // holds the CC accumulator + tool-flush bookkeeping) — only the streaming path touches it.
  const geminiTranslator = createGeminiStreamTranslator(modelId)
  let requestContext: RequestContext | undefined
  let truncateBaseline: ChatCompletionsPayload | undefined

  return {
    format: CLIENT_FORMAT,

    parse(raw) {
      const { env, baseline, ctx } = parseGemini(raw, modelId)
      requestContext = ctx
      truncateBaseline = baseline
      // Attach the request-lifecycle-STABLE outbound-leg supply (RFC §11.2 / R2) so the CellAssembly reads
      // the `truncateBaseline` (the CC auto-truncate baseline) from `env.requestState` — the forward `@cc`
      // cell reads it via `OUTBOUND_LEGS[CHAT_COMPLETIONS]` (C3). The REVERSE `@messages` leg supply (C2b —
      // the shared beta probe + mapper holder) is added when the handler injects them; both coexist.
      // Populating requestState is also the driver's cell-keyed fork discriminator.
      return env.with({
        requestState: {
          truncateBaseline: baseline,
          ...(opts?.reverseBetaProbe && { betaProbe: opts.reverseBetaProbe }),
          ...(opts?.reverseMapperHolder && { reverseMapperHolder: opts.reverseMapperHolder }),
        },
      })
    },

    getContext() {
      return requestContext
    },

    getTruncateBaseline() {
      return truncateBaseline
    },

    // S2 translateOut / S4 prepareWire / S4-sample: the CellAssembly's `OUTBOUND_LEGS` own the outbound
    // wire for every real Gemini request (via the shared cc/responses leg cores); the codec no longer
    // implements them. renderResponse below is the RESPONSE side (InboundCodec) — Gemini's CC→Gemini hop.

    // renderResponse normalizes the upstream to CC (cc handles the via-responses Responses→CC
    // leg), then drives the per-request CC→Gemini translator per-frame (B5) so the owns-sink driver
    // writes Gemini frames directly. renderResponseNonStreaming stays CC (the non-streaming handler
    // does its own `convertOpenAIResponseToGemini`).
    renderResponse(frame, env) {
      const ccRendered = cc.renderResponse(frame, env)
      const ccFrames = Array.isArray(ccRendered) ? ccRendered : [ccRendered]
      const out: Array<ClientFrame> = []
      for (const ccFrame of ccFrames) {
        for (const step of geminiTranslator.renderFrame(ccFrame as ServerSentEventMessage)) {
          out.push(step.frame)
        }
      }
      return out
    },

    flushResponse(_env) {
      return geminiTranslator.flush().map((step) => step.frame)
    },

    getStreamMeta() {
      return geminiTranslator.getMeta()
    },

    renderResponseNonStreaming(upstream, env) {
      return cc.renderResponseNonStreaming(upstream, env)
    },

    createResponseAccumulator(env): ResponseAccumulator {
      // Upstream is CC (passthrough) or normalized-to-CC (via-responses), so the
      // outbound-track accumulator is the CC one. (`env` threaded to the cc delegate for the interface;
      // Gemini has no `→ messages` translate leg, so the leg never changes the accumulator.)
      return cc.createResponseAccumulator(env)
    },

    formatError(err, _env) {
      return formatGeminiError(err)
    },
  }
}

// ============================================================================
// S1 — parse (Gemini → CC + Gemini ctx)
// ============================================================================

/**
 * S1: inbound Gemini HTTP → envelope (CC-shaped body + Gemini ctx). Reproduces
 * the legacy `prepareGeminiRequest` (routes/gemini/handler.ts): snapshot the raw
 * Gemini body, resolve the model, translate Gemini→CC (recording dropped params),
 * create the `gemini-generate-content` ctx with the Gemini-shape original request,
 * sanitize + fill O10. `env.body` is the sanitized + O10-filled CC payload.
 *
 * Async system-prompt injection (`processOpenAIMessages`) is done by the route
 * BEFORE parse on the translated CC messages (parse is sync, the injection is
 * async + non-idempotent — parity with the CC/Responses codecs); the route passes
 * the already-injected CC body as `raw.body` and the raw Gemini body as
 * `raw.originalBodyForHistory`.
 */
function parseGemini(raw: RawHttpRequest, modelId: string): { env: RequestEnvelope; baseline: ChatCompletionsPayload; ctx: RequestContext } {
  // `raw.body` is the post-system-prompt CC payload (the route translated Gemini→CC
  // and injected system-prompt); `raw.originalBodyForHistory` is the raw Gemini body.
  // Defensively clone the Gemini body for the history snapshot (parity with the
  // legacy `structuredClone(body)` — guards history against any later mutation of
  // the live request object).
  const ccBody = raw.body as ChatCompletionsPayload
  const geminiSnapshot = structuredClone(raw.originalBodyForHistory as GenerateContentRequest)

  const resolvedTarget = raw.preResolved ?? resolveModelTarget(modelId)
  const resolvedName = resolvedTarget.name
  const routeOverride = resolvedTarget.routeOverride
  const selectedModel = raw.preResolved ? raw.preResolved.model : state.modelIndex.get(resolvedName)

  // Re-derive the lossy-translation dropped params from the raw Gemini body. The
  // translation is a pure function of the body; re-running it (the route already
  // translated for the wire body + system-prompt) yields the same droppedParams
  // without threading a Gemini-specific field through RawHttpRequest.
  const { droppedParams } = convertGeminiRequestToOpenAI(geminiSnapshot, { model: resolvedName, stream: ccBody.stream ?? false })

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
    model: modelId, // client's original (pre-resolution) name
    // `messages` reflects the original wire shape (Gemini contents), mirroring how
    // the Anthropic handler stores Anthropic-shape messages.
    messages: projectGeminiContentsAsMessages(geminiSnapshot.contents ?? [], geminiSnapshot.systemInstruction),
    stream: ccBody.stream ?? false,
    tools: geminiSnapshot.tools?.flatMap((t) => (t.functionDeclarations ?? []).map((f) => ({ name: f.name ?? "", description: f.description }))),
    payload: geminiSnapshot,
  })
  ctx.setInboundRequestHeaders(captureInboundHeaders(raw.headers))

  if (droppedParams.length > 0) {
    const message = `Gemini → ChatCompletions translation dropped unsupported params: ${droppedParams.join(", ")}`
    consola.warn(`[gemini] model=${resolvedName} ${message}`)
    ctx.addWarningMessage({ code: DROPPED_GEMINI_PARAMS_WARNING_CODE, message })
    ctx.recordFeature("dropped-params")
  }

  ctx.setResolvedModel({
    resolved: resolvedName,
    ...(modelId !== resolvedName && { client: modelId }),
  })

  // Sanitize + fill O10 (mirrors legacy prepareGeminiRequest). Unlike the CC codec
  // (which defers O10 to prepareWire), Gemini fills it here so env.body — and thus
  // the effective history track — carries it, matching the legacy Gemini pipeline.
  const { payload: sanitizedPayload } = sanitizeOpenAIMessages(ccBody)
  const filledPayload = fillMaxCompletionTokens(sanitizedPayload, selectedModel)

  const env = makeEnvelope({
    targetEndpoint: ENDPOINT.CHAT_COMPLETIONS, // initial; the driver overwrites it after S2 routing (see lib/pipeline/router)
    ...(routeOverride && { routeOverride }),
    model: selectedModel as ResolvedModel,
    stream: filledPayload.stream ?? false,
    body: filledPayload,
    ctx,
  })

  // The post-system-prompt, PRE-sanitize CC payload is the stable auto-truncate
  // baseline — matching the legacy `originalPayload` (openaiPayload before sanitize).
  return { env, baseline: ccBody, ctx }
}

function parseContentLength(header: string | null): number | undefined {
  if (header === null) return undefined
  const n = Number.parseInt(header, 10)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Project Gemini `Content[]` into the loosely-typed `MessageContent[]` the history
 * layer accepts (role + parts verbatim). Optional `systemInstruction` is prepended
 * as a synthetic role:"system" entry. Mirrors the legacy handler helper.
 */
function projectGeminiContentsAsMessages(contents: ReadonlyArray<GeminiContent>, systemInstruction: GeminiContent | undefined): Array<MessageContent> {
  const out: Array<MessageContent> = []
  if (systemInstruction) {
    out.push({ role: "system", content: systemInstruction.parts ?? [] } as unknown as MessageContent)
  }
  for (const content of contents) {
    out.push({ role: content.role ?? "user", content: (content.parts ?? []) as ReadonlyArray<GeminiPart> } as unknown as MessageContent)
  }
  return out
}

// ============================================================================
// S7 — formatError (Gemini gRPC-shape)
// ============================================================================

/**
 * Map a classified stream error to a Gemini data-only error frame. Real Gemini
 * SDK clients parse every `data:` frame into `GenerateContentResponse` and drop
 * named `event:` frames, so the error rides as a data-only candidate + sidecar.
 *
 * Note (P2.2-D4 parity): the locked signature hands only the classified kind, not
 * the raw message — the handler-v4 builds the richer inline error frame (with the
 * raw message). This is for completeness / driver S7 callers.
 */
const STREAM_ERROR_STATUS: Record<ClassifiedStreamError, string> = {
  "idle-timeout": "DEADLINE_EXCEEDED",
  shutdown: "UNAVAILABLE",
  "client-abort": "CANCELLED",
  "reaper-cancel": "UNAVAILABLE",
  other: "INTERNAL",
}
const STREAM_ERROR_MESSAGES: Record<ClassifiedStreamError, string> = {
  "idle-timeout": "Stream idle timeout",
  shutdown: "Server is shutting down",
  "client-abort": "Client disconnected",
  "reaper-cancel": "Request cancelled by stale-request reaper",
  other: "Stream error",
}

function formatGeminiError(err: ClassifiedStreamError): ClientFrame {
  const message = STREAM_ERROR_MESSAGES[err]
  return {
    data: JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: message }] }, finishReason: "OTHER", index: 0 }],
      error: { code: err === "shutdown" ? 503 : 500, message, status: STREAM_ERROR_STATUS[err] },
    }),
  }
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

/** Build a {@link RequestEnvelope} (clientFormat `gemini`, CC-shaped body). */
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
      return createGeminiLazyView(env.body)
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
 * Lazy, read-only neutral projection of the (CC-shaped) body. The driver does not
 * run request rewrites for Gemini (no Gemini-format rewrites registered), so this
 * is effectively unused — a minimal CC projection for the interface contract.
 */
function createGeminiLazyView(body: unknown): LazyMessageView {
  const payload = body as ChatCompletionsPayload
  const messages = (): ReadonlyArray<NeutralMessage> =>
    payload.messages.map((m) => ({
      role: m.role,
      hasThinking: false,
      hasImages: Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"),
      toolUseCount: m.tool_calls?.length ?? 0,
      toolResultCount: m.role === "tool" ? 1 : 0,
    }))
  const tools = (): ReadonlyArray<NeutralTool> => (payload.tools ?? []).map((t) => ({ name: t.function.name }))

  return {
    get messages() {
      return messages()
    },
    get tools() {
      return tools()
    },
    get system(): NeutralSystem | undefined {
      const sys = payload.messages.find((m) => m.role === "system" || m.role === "developer")
      return sys ? { text: typeof sys.content === "string" ? sys.content : "" } : undefined
    },
    get summary() {
      return {
        messageCount: payload.messages.length,
        hasTools: (payload.tools?.length ?? 0) > 0,
        hasThinking: false,
        hasImages: false,
      }
    },
  }
}
