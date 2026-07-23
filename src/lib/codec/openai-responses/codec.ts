/**
 * v4 pipeline — openai-responses FormatCodec (P2.4).
 *
 * Encapsulates everything that makes the OpenAI Responses client format differ
 * from the inbound HTTP / upstream wire: parse, route decision (direct
 * `/responses` vs `/chat/completions` fallback vs reject), the last-mile wire
 * prep (incl. the Responses→CC fallback bridge), per-frame response render (incl.
 * the CC→Responses fallback bridge), the error-frame shape, and the response
 * accumulator factory.
 *
 * **Per-request stateful factory.** `createOpenAiResponsesCodec()` is constructed
 * once per request. The instance is a *coding session*: it holds per-request
 * state in the closure — the fallback exchange (stable `resp_`/`item_` IDs +
 * rebuilt prior conversation) and the lazily-built CC→Responses stream translator,
 * whose cross-frame state the per-frame `renderResponse` interface has no slot
 * for. This is the codec paradigm (docs/v4/03-spec/codec.md §1).
 *
 * **Design parity with openai-cc (P2.2-D1):** `translateOut` is identity and the
 * Responses→CC fallback translation lives in `prepareWire` (S4), NOT translateOut
 * (S2). This keeps `env.body` Responses-shaped through S3/S4 so the history
 * **effective** track stays `openai-responses` (matching the legacy pipeline,
 * which records the un-translated Responses payload as effectiveRequest and only
 * the in-execute CC translation as the wire track). The retry strategies are
 * network + token-refresh only (no auto-truncate, retry-transport.md §2.2), so —
 * unlike CC — there is no strategy-shape constraint forcing this; the two-track
 * equivalence is the reason.
 *
 * **Direct stream-id-sync + tool-name restore stay handler-side** (P2-era division
 * of labor, mirroring openai-cc): `renderResponse` is identity for the direct
 * path; the handler-v4 pump applies `fixStreamEventIds` (direct only) + tool-name
 * restore + forwarded sampling. The fallback closing lifecycle events come from
 * {@link OpenAiResponsesCodec.flushResponse} (the per-frame translator's `flush`),
 * called by the handler post-loop — the per-frame `renderResponse` model has no
 * stream-end hook (mirrors how openai-cc synthesizes the trailing `[DONE]`).
 */

import consola from "consola"

import type { AnthropicMessageResponse } from "~/lib/anthropic/client"
import type { BetaProbe } from "~/lib/anthropic/pipeline"
import type { RequestContext } from "~/lib/context/request"
import type { EndpointType } from "~/lib/history/store"
import type { Model } from "~/lib/models/client"
import type {
  //
  AnthropicToCcStreamMeta,
  CCToResponsesStreamTranslator,
  TranslateExchangeContext,
} from "~/lib/openai/translate"
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
import type { ReverseStreamTranslator } from "~/lib/pipeline/hub-translate"
import type { RequestState } from "~/lib/pipeline/request-state"
import type {
  //
  CandidateResponseRenderer,
  ClassifiedStreamError,
  ClientFrame,
  FormatCodec,
  RawHttpRequest,
  ResponseAccumulator,
} from "~/lib/pipeline/types"
import type { PrepareHints } from "~/lib/request/retry-types"
import type { ChatCompletionResponse } from "~/types/api/openai-chat-completions"
import type {
  //
  ResponsesInputItem,
  ResponsesPayload,
} from "~/types/api/openai-responses"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { createAnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import { resolveCodecModel } from "~/lib/codec/model-resolution"
import {
  //
  buildReverseResanitize,
  createReverseAnthropicMapperHolder,
  type ReverseAnthropicMapperHolder,
} from "~/lib/codec/openai-cc/reverse-anthropic-rewrite"
import {
  //
  modelIdFor,
  stripThinkingSignatureFor,
} from "~/lib/config/model-translation"
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
  type RouteOverride,
} from "~/lib/models/resolver"
import { resolveResponseSessionId } from "~/lib/openai/response-session-store"
import {
  //
  normalizeCallIds,
  responsesInputToMessages,
} from "~/lib/openai/responses-conversion"
import { createResponsesStreamAccumulator } from "~/lib/openai/responses-stream-accumulator"
import { stripImageGenerationTool } from "~/lib/openai/responses-tool-filter"
import { streamErrorKindToOpenAIErrorType } from "~/lib/openai/stream-error"
import {
  //
  applyResponsesToolNameSanitization,
  buildResponsesToolNameMapper,
} from "~/lib/openai/tool-name-sanitize"
import {
  //
  createCCToResponsesStreamTranslator,
  translateAnthropicResponseToResponses,
  translateCCToResponsesResponse,
} from "~/lib/openai/translate"
import { createCandidateStateFactory } from "~/lib/pipeline/generation/candidate-state"
import {
  //
  createReverseStreamTranslator,
} from "~/lib/pipeline/hub-translate"
import { state } from "~/lib/state"
import { applyInboundSystemPrompt } from "~/lib/system-prompt"
import { rebuildConversationMessages } from "~/routes/responses/conversation-rebuild"

import { type ResponsesFallbackScratch } from "./openai-responses-leg"

const CLIENT_FORMAT: ClientFormat = "openai-responses"
const ENDPOINT_TYPE: EndpointType = "openai-responses"

/**
 * The openai-responses codec, widened beyond {@link FormatCodec} with the
 * per-request context + fallback accessors. The driver consumes it as a plain
 * `FormatCodec`; the route/handler reads the extras.
 */
export interface OpenAiResponsesCodec extends FormatCodec {
  /** The RequestContext created by `parse` (route `c.set` + failure settle). `undefined` before parse. */
  getContext(): RequestContext | undefined
  /** The fallback exchange's `resp_` id (handler session registration). `undefined` for direct / before translateOut. */
  getFallbackResponseId(): string | undefined
  /**
   * Stream-end flush of the fallback CC→Responses OR reverse Anthropic→CC→Responses closing lifecycle
   * events (`output_text.done` … `response.completed`). Returns `[]` for the direct path. The handler
   * calls it after the `driver.runResponse` loop (the per-frame `renderResponse` has no stream-end hook).
   */
  flushResponse(env: RequestEnvelope): Array<ClientFrame>
  /**
   * REVERSE `@messages`-leg terminal stream meta (Phase 5): the CC `finish_reason` (undefined ⇒
   * truncation, F2) + grossed-up usage the Anthropic→CC translator accumulated. `undefined` for the
   * direct/fallback legs.
   */
  getStreamMeta(): AnthropicToCcStreamMeta | undefined
}

/** Args for {@link createOpenAiResponsesCodec}. */
export interface CreateOpenAiResponsesCodecArgs {
  /**
   * REVERSE `@messages` leg only: the shared per-request beta probe (also injected into the reverse
   * Anthropic strategies). `prepareWire` records the outbound Anthropic betas into it. Absent for the
   * direct/fallback legs.
   */
  reverseBetaProbe?: BetaProbe
  /**
   * REVERSE `@messages` leg only: the shared per-request mapper holder. `parse` threads it onto
   * `env.requestState` so the `OUTBOUND_LEGS[/v1/messages]` reverse branch (C2b) reads the SAME instance
   * for its sanitize rewrite + resanitize. Absent for the direct/fallback legs.
   */
  reverseMapperHolder?: ReverseAnthropicMapperHolder
}

/** Generate a short, collision-safe ID using crypto.randomUUID (matches the legacy fallback). */
function genShortId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 11)
}

/**
 * RFC §4.3 scenario A/B (Phase 5): resolve `{ stripThinkingSignature }` for the REVERSE
 * `(openai-responses client, Claude model @messages)` reasoning round-trip. Only meaningful on the
 * MESSAGES leg (the fallback `/chat/completions` two-hop path has no reasoning round-trip carrier
 * concept) — passing it unconditionally on every reverse call site is harmless (the CC-family
 * factories in hub-translate.ts simply ignore an opts param they never read).
 */
function reasoningRoundTripOpts(env: RequestEnvelope): { stripThinkingSignature: boolean } {
  const modelId = modelIdFor(env.model as Model | undefined, (env.body as { model?: string }).model)
  return { stripThinkingSignature: stripThinkingSignatureFor("openai-responses", modelId, "anthropic-messages") }
}

/**
 * Build the openai-responses codec for one request. The returned instance holds
 * the per-request fallback exchange + CC→Responses translator in its closure.
 */
export function createOpenAiResponsesCodec(args?: CreateOpenAiResponsesCodecArgs): OpenAiResponsesCodec {
  let requestContext: RequestContext | undefined
  // The resolved upstream model name (for the fallback / reverse translator's resolvedModel).
  let resolvedModelName = ""
  // Fallback (Responses→CC) exchange SCRATCH (RFC §11.2c): a shared MUTABLE holder both this codec's render
  // side (reads exchange ids/resolvedModel) and — once C4a routes the CHAT cell through the assembly — the
  // OUTBOUND_LEGS[CHAT_COMPLETIONS] fallback leg (calls `ensure` in translateOut, reads rebuiltMessages in
  // prepareWire) reference. parse threads it onto env.requestState so both sides see the SAME instance.
  // `ensure` builds the exchange LAZILY + idempotently (the build closure lives here — it needs
  // resolvedModelName / genShortId / rebuildConversationMessages); undefined for a direct request.
  const createFallbackScratch = (): ResponsesFallbackScratch => {
    const scratch: ResponsesFallbackScratch = {
      exchange: undefined,
      ensure(env) {
        return (scratch.exchange ??= {
          responseId: `resp_${genShortId()}`,
          itemId: `item_${genShortId()}`,
          resolvedModel: resolvedModelName || (env.body as ResponsesPayload).model,
          rebuiltMessages: rebuildConversationMessages(env.ctx.sessionId),
        })
      },
    }
    return scratch
  }
  const fallbackScratch = createFallbackScratch()
  const createRenderer = (candidateEnv?: RequestEnvelope): CandidateResponseRenderer => {
    let ccTranslator: CCToResponsesStreamTranslator | null = null
    let reverseExchange: TranslateExchangeContext | undefined
    let reverseTranslator: ReverseStreamTranslator | undefined
    const candidateScratch = candidateEnv?.requestState?.responsesFallbackScratch as ResponsesFallbackScratch | undefined
    const ensureCcTranslator = (): CCToResponsesStreamTranslator | null => {
      // The default renderer is created before the fallback leg's prepareWire calls `ensure()`.
      // Resolve lazily so both legacy and candidate renderers observe the eventual exchange ids.
      const fallbackExchange = candidateScratch?.exchange ?? fallbackScratch.exchange
      if (!fallbackExchange) return null
      ccTranslator ??= createCCToResponsesStreamTranslator({
        responseId: fallbackExchange.responseId,
        itemId: fallbackExchange.itemId,
        resolvedModel: fallbackExchange.resolvedModel,
      })
      return ccTranslator
    }
    const ensureReverseExchange = (env: RequestEnvelope): TranslateExchangeContext =>
      (reverseExchange ??= {
        responseId: `resp_${genShortId()}`,
        itemId: `item_${genShortId()}`,
        resolvedModel: resolvedModelName || (env.body as { model?: string }).model || "",
      })
    const ensureReverseTranslator = (env: RequestEnvelope): ReverseStreamTranslator => {
      const modelId = modelIdFor(env.model as Model | undefined, (env.body as { model?: string }).model) ?? ""
      return (reverseTranslator ??= createReverseStreamTranslator(CLIENT_FORMAT, modelId, ensureReverseExchange(env), reasoningRoundTripOpts(env)))
    }
    return {
      renderResponse(frame, env) {
        if (env.targetEndpoint === ENDPOINT.RESPONSES) return frame
        if (env.targetEndpoint === ENDPOINT.MESSAGES) return ensureReverseTranslator(env).renderFrame(frame)
        const translator = ensureCcTranslator()
        if (!translator) return []
        return translator.translate(frame.data ?? "").map((event): ClientFrame => ({ event: event.event, data: event.data }))
      },
      flushResponse(env) {
        if (env.targetEndpoint === ENDPOINT.MESSAGES) return ensureReverseTranslator(env).flush()
        if (env.targetEndpoint === ENDPOINT.RESPONSES) return []
        const translator = ensureCcTranslator()
        if (!translator) return []
        return translator.flush().map((event): ClientFrame => ({ event: event.event, data: event.data }))
      },
      getStreamMeta() {
        return reverseTranslator?.getMeta()
      },
    }
  }
  const defaultRenderer = createRenderer()

  /** Build the non-streaming reverse exchange once for the legacy request-level path. */
  let reverseExchange: TranslateExchangeContext | undefined
  const ensureReverseExchange = (env: RequestEnvelope): TranslateExchangeContext =>
    (reverseExchange ??= {
      responseId: `resp_${genShortId()}`,
      itemId: `item_${genShortId()}`,
      resolvedModel: resolvedModelName || (env.body as { model?: string }).model || "",
    })

  return {
    format: CLIENT_FORMAT,

    parse(raw) {
      const parsed = parseOpenAiResponses(raw)
      requestContext = parsed.env.ctx
      resolvedModelName = parsed.resolvedModelName
      // Attach the request-lifecycle-STABLE outbound-leg supply (RFC §11.2 / R2) so the CellAssembly reads
      // it from env.requestState. The shared fallback-exchange scratch (§11.2c) is always threaded (the CHAT
      // fallback leg reads/writes it in C4a; inert on direct/reverse). The REVERSE `@messages` leg supply
      // (C2b — beta probe + mapper holder) is added when the handler injects them; all coexist. Populating
      // requestState is also the driver's cell-keyed fork discriminator (an env without it stays legacy).
      return parsed.env.with({
        requestState: {
          responsesFallbackScratch: fallbackScratch,
          ...(args?.reverseBetaProbe && { betaProbe: args.reverseBetaProbe }),
          ...(args?.reverseMapperHolder && { reverseMapperHolder: args.reverseMapperHolder }),
        },
      })
    },

    getContext() {
      return requestContext
    },

    // S1b (RFC 2026-07-14 §4): 委托统一入站分发（spec 2026-07-20-inbound-system-prompt-dispatch-hook §3.1）。
    // `client.inbound` (Phase 4) 仍见 pre-injection 原生 body。
    translateInbound(env) {
      return applyInboundSystemPrompt(env)
    },

    getFallbackResponseId() {
      return fallbackScratch.exchange?.responseId
    },

    // S2 translateOut / S4 prepareWire / S4-sample are owned by the CellAssembly's `OUTBOUND_LEGS` for every
    // real request (direct `/responses` + fallback `/chat/completions` via the responses/cc cells, reverse
    // `@messages` via the anthropic cell); the codec no longer implements them. The RESPONSE-side render below
    // stays here (InboundCodec): it reads the SAME per-request fallback scratch (`env.requestState`, populated
    // by the cell) + lazily builds the reverse-exchange (`??=`, observably equivalent to the old eager build).

    renderResponse(frame, env) {
      return defaultRenderer.renderResponse(frame, env)
    },
    createCandidateRenderer(env) {
      return createRenderer(env)
    },
    createCandidateStateFactory(env) {
      return createCandidateStateFactory(env, {
        createBetaProbe,
        createReverseMapperHolder: () => createReverseAnthropicMapperHolder(env.model.id, env.model.vendor),
        createResponsesFallbackScratch: () => createFallbackScratch(),
        createResanitize: ({ source, reverseMapperHolder }) =>
          reverseMapperHolder ?
            (payload) => buildReverseResanitize(reverseMapperHolder as ReverseAnthropicMapperHolder)(payload as never)
          : (payload) => source(payload),
      })
    },

    flushResponse(env) {
      return defaultRenderer.flushResponse(env)
    },

    getStreamMeta() {
      return defaultRenderer.getStreamMeta?.() as AnthropicToCcStreamMeta | undefined
    },

    renderResponseNonStreaming(upstream, env) {
      if (env.targetEndpoint === ENDPOINT.RESPONSES) return upstream
      // REVERSE `@messages` leg — DIRECT bridge (RFC 2026-07-14-anthropic-responses-direct-bridge §3/§4.2,
      // Phase 4 subtask E): a single-hop Anthropic upstream → Responses walk, skipping the CC intermediate
      // entirely (was Anthropic→CC(hub)→Responses, 疑点 5). `upstream` here is the RAW Anthropic response
      // (the hub's CC bridge is no longer called on this leg) — reuses the SAME `ensureReverseExchange`
      // id-management the old two-hop path used (RFC §2.3: no new exchange contract).
      if (env.targetEndpoint === ENDPOINT.MESSAGES) {
        return translateAnthropicResponseToResponses(upstream as AnthropicMessageResponse, ensureReverseExchange(env), reasoningRoundTripOpts(env))
      }
      if (!fallbackScratch.exchange) return upstream
      return translateCCToResponsesResponse(upstream as ChatCompletionResponse, {
        responseId: fallbackScratch.exchange.responseId,
        itemId: fallbackScratch.exchange.itemId,
        resolvedModel: fallbackScratch.exchange.resolvedModel,
      })
    },

    formatError(err, _env) {
      return formatOpenAiResponsesError(err)
    },

    createResponseAccumulator(env): ResponseAccumulator {
      // REVERSE `@messages` leg's upstream is Anthropic → the Anthropic accumulator (honest outbound,
      // RFC §4.1). The direct/fallback legs' upstream is Responses-shaped.
      if (env.targetEndpoint === ENDPOINT.MESSAGES) return createAnthropicStreamAccumulator()
      return createResponsesStreamAccumulator()
    },
  }
}

// ============================================================================
// S1 — parse
// ============================================================================

/**
 * S1: inbound HTTP → envelope. **Synchronous** (the FormatCodec.parse contract).
 *
 * Mirrors the legacy `handleResponses` pre-dispatch setup: snapshot the raw
 * client body, strip the image_generation tool (config-gated O11), resolve the
 * model (Azure/preResolved), create the ctx + inbound sampling, normalize call
 * IDs (config-gated), and apply request-side tool-name sanitization. `env.body`
 * becomes the processed Responses payload (still Responses-shaped — the fallback
 * translation is deferred to `prepareWire`).
 *
 * Async, non-idempotent system-prompt injection (`processResponsesInstructions`)
 * is done by the route BEFORE `parse` (parse is sync), passing the pre-injection
 * client body as `originalBodyForHistory` for the snapshot — parity with the CC
 * codec (P2.2-D3).
 */
function parseOpenAiResponses(raw: RawHttpRequest): { env: RequestEnvelope; resolvedModelName: string } {
  const incoming = raw.body as ResponsesPayload
  const clientBody = (raw.originalBodyForHistory ?? raw.body) as ResponsesPayload

  // Snapshot the CLIENT raw (pre-strip, pre-instructions, pre-rewrite) for history.
  const originalSnapshot = structuredClone(clientBody)

  // Working payload (the route already injected system-prompt instructions into
  // `incoming`). Strip the image_generation builtin tool (config-gated) AFTER the
  // snapshot so history retains evidence the client sent it.
  const working: ResponsesPayload = { ...incoming }
  stripImageGenerationTool(working)

  // Model resolution (requested/resolved/selected/clientModel) via the shared
  // codec primitive. Azure deployment routes inject the deployment name as an
  // explicit `modelOverride` (path wins over body.model); the primitive folds it
  // into `requestedModel`.
  const { requestedModel, resolvedName, routeOverride, selectedModel, clientModel } = resolveCodecModel(raw)
  if (resolvedName !== requestedModel) consola.debug(`Model name resolved: ${requestedModel} → ${resolvedName}`)
  working.model = resolvedName

  // Create the request context (triggers "created" → history insert).
  const manager = getRequestContextManager()
  const reqBodySize = parseContentLength(raw.headers.get("content-length"))
  const ctx = manager.create({
    endpoint: ENDPOINT_TYPE,
    sessionId: getSessionIdFromHeaders(raw.headers) ?? resolveResponseSessionId(incoming.previous_response_id),
    agentId: getAgentIdFromHeaders(raw.headers),
    ...(raw.path !== undefined && { rawPath: raw.path, path: raw.path }),
    ...(raw.query !== undefined && { query: raw.query }),
    ...(raw.method !== undefined && { method: raw.method }),
    ...(reqBodySize !== undefined && { requestBodySize: reqBodySize }),
    ...(raw.operationIdentity !== undefined && { operationIdentity: raw.operationIdentity }),
  })

  ctx.setOriginalRequest({
    model: requestedModel,
    messages: responsesInputToMessages(originalSnapshot.input),
    stream: originalSnapshot.stream ?? false,
    tools: originalSnapshot.tools,
    system: originalSnapshot.instructions ?? undefined,
    payload: originalSnapshot,
  })
  ctx.setInboundRequestHeaders(captureInboundHeaders(raw.headers))
  ctx.recordModelOperationIngress()

  // Normalize call IDs (call_ → fc_) BEFORE tool-name sanitization — matches the
  // legacy handler order (handleResponses: normalizeCallIds then tool-name). This
  // is a request-side rewrite on the logical request, so it lands on env.body
  // (effective track), unlike CC's via-responses normalizeCallIds (wire-only).
  let processed = state.normalizeResponsesCallIds ? normalizeCallIds(working) : working

  // Tool-name sanitization (client → upstream). The mapper is stored on ctx so
  // the response-side restore can reverse it.
  const toolNameMapper = buildResponsesToolNameMapper(processed, selectedModel?.vendor)
  ctx.setToolNameMapper(toolNameMapper)
  processed = applyResponsesToolNameSanitization(processed, toolNameMapper)

  ctx.setResolvedModel({
    resolved: resolvedName,
    ...(clientModel !== undefined && { client: clientModel }),
  })

  const env = makeEnvelope({
    targetEndpoint: ENDPOINT.RESPONSES, // initial; the driver overwrites it after S2 routing (see lib/pipeline/router)
    ...(routeOverride && { routeOverride }),
    model: selectedModel as ResolvedModel,
    stream: processed.stream ?? false,
    body: processed,
    ctx,
  })

  return { env, resolvedModelName: resolvedName }
}

function parseContentLength(header: string | null): number | undefined {
  if (header === null) return undefined
  const n = Number.parseInt(header, 10)
  return Number.isFinite(n) ? n : undefined
}

// ============================================================================
// S7 — formatError
// ============================================================================

/** Kind-derived error-frame messages (P2.2-D4 parity — raw message is unavailable here). */
const STREAM_ERROR_MESSAGES: Record<ClassifiedStreamError, string> = {
  "idle-timeout": "Stream idle timeout",
  shutdown: "Server is shutting down",
  "client-abort": "Client disconnected",
  "reaper-cancel": "Request cancelled by stale-request reaper",
  "dispatch-cancel": "Upstream dispatch cancelled",
  other: "Stream error",
}

function formatOpenAiResponsesError(err: ClassifiedStreamError): ClientFrame {
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

/** Build a {@link RequestEnvelope} with a lazy Responses projection. */
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
      return createResponsesLazyView(env.body)
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
 * Lazy, read-only neutral projection of a Responses payload. **Not** a
 * normalization IR — exposes just enough for routing / logging / gate decisions;
 * rewrites that need byte fidelity operate on `env.body` directly. The body may be
 * a CC payload after a fallback translateOut/prepareWire, but `view` is only read
 * on the Responses-shaped body (S2/S3), so it projects the Responses `input`.
 */
function createResponsesLazyView(body: unknown): LazyMessageView {
  const payload = body as ResponsesPayload
  let messagesCache: ReadonlyArray<NeutralMessage> | undefined
  let toolsCache: ReadonlyArray<NeutralTool> | undefined

  const inputItems = (): Array<ResponsesInputItem> => (Array.isArray(payload.input) ? payload.input : [])
  const messages = (): ReadonlyArray<NeutralMessage> => (messagesCache ??= inputItems().map((item) => projectInputItem(item)))
  const tools = (): ReadonlyArray<NeutralTool> =>
    (toolsCache ??= (payload.tools ?? []).filter((t) => t.type === "function").map((t) => ({ name: (t as { name: string }).name })))
  const system = (): NeutralSystem | undefined => (payload.instructions ? { text: payload.instructions } : undefined)

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
      const items = inputItems()
      return {
        messageCount: items.length,
        hasTools: (payload.tools?.length ?? 0) > 0,
        hasThinking: false,
        hasImages: items.some((item) => inputItemHasImages(item)),
      }
    },
  }
}

function projectInputItem(item: ResponsesInputItem): NeutralMessage {
  return {
    role: item.role ?? "user",
    hasThinking: item.type === "reasoning",
    hasImages: inputItemHasImages(item),
    toolUseCount: item.type === "function_call" ? 1 : 0,
    toolResultCount: item.type === "function_call_output" ? 1 : 0,
  }
}

function inputItemHasImages(item: ResponsesInputItem): boolean {
  return Array.isArray(item.content) && item.content.some((part) => "type" in part && part.type === "input_image")
}
