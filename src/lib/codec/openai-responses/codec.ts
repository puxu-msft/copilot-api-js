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

import type { BetaProbe } from "~/lib/anthropic/pipeline"
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
import type {
  //
  ClassifiedStreamError,
  ClientFrame,
  FormatCodec,
  PreparedRequest,
  RawHttpRequest,
  RequestSample,
  ResponseAccumulator,
} from "~/lib/pipeline/types"
import type { PrepareHints } from "~/lib/request/pipeline"
import type {
  //
  ChatCompletionResponse,
  Message,
} from "~/types/api/openai-chat-completions"
import type {
  //
  ResponsesInputItem,
  ResponsesPayload,
} from "~/types/api/openai-responses"
import type { MessagesPayload } from "~/types/api/anthropic"

import { prepareAnthropicRequest } from "~/lib/anthropic/request-preparation"
import { createAnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import { getRequestContextManager } from "~/lib/context/manager"
import {
  //
  captureInboundHeaders,
} from "~/lib/fetch-utils"
import { sanitizeHeadersForHistory } from "~/lib/fetch-utils"
import {
  //
  getAgentIdFromHeaders,
  getSessionIdFromHeaders,
  resolveResponseSessionId,
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
import {
  //
  prepareChatCompletionsRequest,
  prepareResponsesRequest,
} from "~/lib/openai/request-preparation"
import {
  //
  extractInputItems,
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
  translateCCToResponsesResponse,
  translateResponsesToChatCompletions,
} from "~/lib/openai/translate"
import {
  //
  createReverseStreamTranslator,
  renderResponseNonStreamingVia,
  translateRequestVia,
} from "~/lib/pipeline/hub-translate"
import { state } from "~/lib/state"
import { rebuildConversationMessages } from "~/routes/responses/conversation-rebuild"

const CLIENT_FORMAT: ClientFormat = "openai-responses"
const ENDPOINT_TYPE: EndpointType = "openai-responses"
/** History `format` label for the fallback wire (the actual upstream endpoint). */
const CC_ENDPOINT_TYPE: EndpointType = "openai-chat-completions"
/** History `format` label for the REVERSE `@messages`-leg wire (the actual upstream endpoint). */
const ANTHROPIC_MESSAGES_ENDPOINT_TYPE: EndpointType = "anthropic-messages"

/** Per-request fallback exchange state (stable IDs + rebuilt prior conversation). */
interface FallbackExchange {
  responseId: string
  itemId: string
  /** Model name for the CC→Responses translator's `response.created.model` (resolved name). */
  clientModel: string
  /** Prior conversation rebuilt from session history, prepended to the translated CC payload. */
  rebuiltMessages: Array<Message>
}

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
}

/** Generate a short, collision-safe ID using crypto.randomUUID (matches the legacy fallback). */
function genShortId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 11)
}

/**
 * Build the openai-responses codec for one request. The returned instance holds
 * the per-request fallback exchange + CC→Responses translator in its closure.
 */
export function createOpenAiResponsesCodec(args?: CreateOpenAiResponsesCodecArgs): OpenAiResponsesCodec {
  let requestContext: RequestContext | undefined
  // The resolved upstream model name (for the fallback / reverse translator's clientModel).
  let resolvedModelName = ""
  // Fallback (Responses→CC) exchange state, initialized once in translateOut.
  let fallback: FallbackExchange | undefined
  // Lazily-built CC→Responses per-frame translator (fallback response side).
  let ccTranslator: CCToResponsesStreamTranslator | null = null
  // REVERSE `@messages` leg (Phase 5): the reverse-exchange (responseId/itemId/clientModel) the two-hop
  // Anthropic→CC→Responses render needs (疑点 5), built once in translateOut, + the reverse translator.
  let reverseExchange: TranslateExchangeContext | undefined
  let reverseTranslator: ReverseStreamTranslator | undefined

  const ensureCcTranslator = (): CCToResponsesStreamTranslator | null => {
    if (!fallback) return null
    ccTranslator ??= createCCToResponsesStreamTranslator({ responseId: fallback.responseId, itemId: fallback.itemId, clientModel: fallback.clientModel })
    return ccTranslator
  }

  /** Build the reverse-exchange once (also used by the non-streaming translateCCToResponsesResponse). */
  const ensureReverseExchange = (env: RequestEnvelope): TranslateExchangeContext =>
    (reverseExchange ??= { responseId: `resp_${genShortId()}`, itemId: `item_${genShortId()}`, clientModel: resolvedModelName || (env.body as { model?: string }).model || "" })

  const ensureReverseTranslator = (env: RequestEnvelope): ReverseStreamTranslator => {
    const modelId = (env.model as Model | undefined)?.id ?? (env.body as { model?: string }).model ?? ""
    return (reverseTranslator ??= createReverseStreamTranslator(CLIENT_FORMAT, modelId, ensureReverseExchange(env)))
  }

  return {
    format: CLIENT_FORMAT,

    parse(raw) {
      const parsed = parseOpenAiResponses(raw)
      requestContext = parsed.env.ctx
      resolvedModelName = parsed.resolvedModelName
      return parsed.env
    },

    getContext() {
      return requestContext
    },

    getFallbackResponseId() {
      return fallback?.responseId
    },

    // S2 translateOut is identity for the direct/fallback legs (Responses-shaped body stays through
    // S3/S4 — module docstring P2.2-D1 parity). For the fallback it ALSO sets up the per-request
    // fallback exchange. For a REVERSE `@messages` leg (Phase 5) it delegates to the hub (two-hop
    // Responses→CC→Anthropic body) + builds the reverse-exchange the response two-hop needs.
    translateOut(env) {
      if (env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS) {
        fallback ??= {
          responseId: `resp_${genShortId()}`,
          itemId: `item_${genShortId()}`,
          clientModel: resolvedModelName || (env.body as ResponsesPayload).model,
          rebuiltMessages: rebuildConversationMessages(env.ctx.sessionId),
        }
        return env
      }
      if (env.targetEndpoint === ENDPOINT.MESSAGES) {
        ensureReverseExchange(env)
        const anthropicBody = translateRequestVia(CLIENT_FORMAT, env.targetEndpoint, env.body, { model: env.model as Model | undefined })
        return env.with({ body: anthropicBody })
      }
      return env
    },

    prepareWire(env) {
      // REVERSE `@messages` leg: the body is Anthropic-shaped (translateOut delegated to the hub) →
      // build the Anthropic wire (a Responses client sends no anthropic-beta; the handler's probe records
      // the outbound betas). The direct/fallback legs stay Responses/CC.
      if (env.targetEndpoint === ENDPOINT.MESSAGES) return prepareReverseAnthropicWire(env, args?.reverseBetaProbe)
      return prepareOpenAiResponsesWire(env, fallback)
    },

    renderResponse(frame, env) {
      // Direct (/responses): forward the upstream Responses frame verbatim.
      if (env.targetEndpoint === ENDPOINT.RESPONSES) return frame
      // REVERSE `@messages` leg (Phase 5): two-hop Anthropic→CC→Responses via the reverse translator.
      if (env.targetEndpoint === ENDPOINT.MESSAGES) return ensureReverseTranslator(env).renderFrame(frame)
      // Fallback (/chat/completions): translate each CC SSE frame → Responses event(s).
      const translator = ensureCcTranslator()
      if (!translator) return []
      return translator.translate(frame.data ?? "").map((ev): ClientFrame => ({ event: ev.event, data: ev.data }))
    },

    flushResponse(env) {
      // REVERSE `@messages` leg: the reverse translator's flush emits the Responses `response.completed`
      // (疑点 7b — MUST be drained or the client never gets the terminal).
      if (env.targetEndpoint === ENDPOINT.MESSAGES) return ensureReverseTranslator(env).flush()
      if (env.targetEndpoint === ENDPOINT.RESPONSES) return []
      const translator = ensureCcTranslator()
      if (!translator) return []
      return translator.flush().map((ev): ClientFrame => ({ event: ev.event, data: ev.data }))
    },

    getStreamMeta() {
      return reverseTranslator?.getMeta()
    },

    renderResponseNonStreaming(upstream, env) {
      if (env.targetEndpoint === ENDPOINT.RESPONSES) return upstream
      // REVERSE `@messages` leg (Phase 5): Anthropic upstream → CC-canonical (hub) → Responses (二跳,
      // 疑点 5 — translateCCToResponsesResponse eats the reverse-exchange).
      if (env.targetEndpoint === ENDPOINT.MESSAGES) {
        const cc = renderResponseNonStreamingVia(ENDPOINT.MESSAGES, upstream).rendered as ChatCompletionResponse
        return translateCCToResponsesResponse(cc, ensureReverseExchange(env))
      }
      if (!fallback) return upstream
      return translateCCToResponsesResponse(upstream as ChatCompletionResponse, {
        responseId: fallback.responseId,
        itemId: fallback.itemId,
        clientModel: fallback.clientModel,
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

    sampleRequest(wire, env): RequestSample {
      return sampleOpenAiResponsesRequest(wire, env)
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

  // Azure deployment routes inject the deployment name as an explicit override
  // (path wins over body.model).
  const clientModel = raw.modelOverride ?? incoming.model
  const resolvedTarget = raw.preResolved ?? resolveModelTarget(clientModel)
  const resolvedName = resolvedTarget.name
  const routeOverride = resolvedTarget.routeOverride
  if (resolvedName !== clientModel) consola.debug(`Model name resolved: ${clientModel} → ${resolvedName}`)
  const selectedModel = raw.preResolved ? raw.preResolved.model : state.modelIndex.get(resolvedName)
  working.model = resolvedName

  // Create the request context (triggers "created" → history insert).
  const manager = getRequestContextManager()
  const reqBodySize = parseContentLength(raw.headers.get("content-length"))
  const ctx = manager.create({
    endpoint: ENDPOINT_TYPE,
    sessionId: getSessionIdFromHeaders(raw.headers) ?? resolveResponseSessionId(incoming.previous_response_id),
    agentId: getAgentIdFromHeaders(raw.headers),
    ...(raw.path !== undefined && { rawPath: raw.path, path: raw.path }),
    ...(raw.method !== undefined && { method: raw.method }),
    ...(reqBodySize !== undefined && { requestBodySize: reqBodySize }),
  })

  ctx.setOriginalRequest({
    model: clientModel, // client's original (pre-resolution) name
    messages: responsesInputToMessages(originalSnapshot.input),
    stream: originalSnapshot.stream ?? false,
    tools: originalSnapshot.tools,
    system: originalSnapshot.instructions ?? undefined,
    payload: originalSnapshot,
  })
  ctx.setInboundRequestHeaders(captureInboundHeaders(raw.headers))

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
    ...(clientModel !== resolvedName && { client: clientModel }),
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
// S4 — prepareWire
// ============================================================================

/**
 * S4 last-mile for the REVERSE `@messages` leg (Phase 5): the body is Anthropic-shaped (translateOut
 * delegated to the hub), so build the Anthropic `/v1/messages` wire via `prepareAnthropicRequest`. A
 * Responses client sends no `anthropic-beta`; the handler's shared probe records the outbound betas.
 */
function prepareReverseAnthropicWire(env: RequestEnvelope, betaProbe: BetaProbe | undefined): PreparedRequest {
  const model = env.model as Model | undefined
  const prepared = prepareAnthropicRequest(env.body as MessagesPayload, {
    ...(model && { resolvedModel: model }),
    ...(env.prepareHints.excludeBetas && { excludeBetas: env.prepareHints.excludeBetas }),
    ...(env.prepareHints.rejectFields && { rejectFields: env.prepareHints.rejectFields }),
    ...(env.prepareHints.excludeServerToolTypes && { excludeServerToolTypes: env.prepareHints.excludeServerToolTypes }),
    ...(env.prepareHints.excludeToolFields && { excludeToolFields: env.prepareHints.excludeToolFields }),
    ...(env.prepareHints.excludeCacheControlSubfields && { excludeCacheControlSubfields: env.prepareHints.excludeCacheControlSubfields }),
    ...(env.prepareHints.contextEscalation && { contextEscalation: env.prepareHints.contextEscalation }),
  })
  betaProbe?.recordOutbound(sanitizeHeadersForHistory(prepared.headers))
  return {
    url: ENDPOINT.MESSAGES,
    headers: new Headers(prepared.headers),
    body: prepared.wire,
    stream: (prepared.wire.stream as boolean | undefined) ?? false,
  }
}

/**
 * S4 last-mile: env → wire, dispatched by `targetEndpoint`.
 *   - `/responses` (direct): `prepareResponsesRequest`.
 *   - `/chat/completions` (fallback): Responses→CC translation + prior-conversation
 *     prepend → `prepareChatCompletionsRequest` (NO O10 fill — matches the legacy
 *     fallback's `createChatCompletions`, which does not auto-fill
 *     max_completion_tokens).
 *
 * The fallback translation lives here (not translateOut) so `env.body` stays
 * Responses-shaped for the effective history track (module docstring P2.2-D1
 * parity). It is idempotent (pure function of env.body + the once-initialized
 * `fallback` exchange), so re-running per retry yields the same wire.
 */
function prepareOpenAiResponsesWire(env: RequestEnvelope, fallback: FallbackExchange | undefined): PreparedRequest {
  const model = env.model as Model | undefined

  if (env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS) {
    const ccPayload = translateResponsesToChatCompletions(env.body as ResponsesPayload)
    // Prepend rebuilt prior conversation (after system/developer prelude, before
    // the current turn's input) — matches the legacy fallback.
    const rebuilt = fallback?.rebuiltMessages ?? []
    if (rebuilt.length > 0) {
      const prelude = ccPayload.messages.filter((m) => m.role === "system" || m.role === "developer")
      const current = ccPayload.messages.filter((m) => m.role !== "system" && m.role !== "developer")
      ccPayload.messages = [...prelude, ...rebuilt, ...current]
    }
    const prepared = prepareChatCompletionsRequest(ccPayload, { resolvedModel: model })
    return {
      url: ENDPOINT.CHAT_COMPLETIONS,
      headers: new Headers(prepared.headers),
      body: prepared.wire,
      stream: prepared.wire.stream ?? false,
    }
  }

  if (env.targetEndpoint !== ENDPOINT.RESPONSES) {
    // Symmetric loud-fail: a `translate` decision to a leg this codec cannot serve
    // (reverse `@messages`, Phase 5) throws instead of silently downgrading to /responses.
    throw new Error(`openai-responses codec cannot prepare wire for targetEndpoint=${env.targetEndpoint} — translation to this leg is not wired in this codec (reverse legs land in Phase 5)`)
  }
  const prepared = prepareResponsesRequest(env.body as ResponsesPayload, { resolvedModel: model })
  return {
    url: ENDPOINT.RESPONSES,
    headers: new Headers(prepared.headers),
    body: prepared.wire,
    stream: prepared.wire.stream ?? false,
  }
}

/**
 * S4 observability (P2.3-S): derive the history-side effective + wire request
 * descriptors for one attempt.
 *
 * `effective` is the Responses-shaped logical request (`env.body` — always
 * Responses, translateOut identity), labeled `openai-responses`. Its `messages`
 * field is `[]` (a Responses payload has `input`, not `messages`) — matching the
 * legacy pipeline's `Array.isArray(p.messages) ? … : []`. `wire` is the actual
 * outbound bytes: direct = Responses (`input` items, `openai-responses`), fallback
 * = CC (`messages`, `openai-chat-completions`).
 */
function sampleOpenAiResponsesRequest(wire: PreparedRequest, env: RequestEnvelope): RequestSample {
  // REVERSE `@messages` leg (Phase 5): env.body + wire are Anthropic-shaped (translateOut delegated to
  // the hub) → sample the Anthropic wire (`messages`; format label `anthropic-messages`).
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

  const effBody = env.body as { model?: unknown; messages?: unknown }
  const effective: EffectiveRequest = {
    model: typeof effBody.model === "string" ? effBody.model : "",
    resolvedModel: env.model as Model | undefined,
    messages: Array.isArray(effBody.messages) ? effBody.messages : [],
    payload: env.body,
    format: ENDPOINT_TYPE,
  }

  const wireBody = wire.body as { model?: unknown; messages?: unknown; input?: string | Array<ResponsesInputItem> }
  const isFallback = env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS
  let wireMessages: Array<unknown>
  if (isFallback) wireMessages = Array.isArray(wireBody.messages) ? wireBody.messages : []
  else wireMessages = extractInputItems(wireBody.input ?? [])
  const wireRequest: WireRequest = {
    model: typeof wireBody.model === "string" ? wireBody.model : "",
    messages: wireMessages,
    payload: wire.body,
    headers: Object.fromEntries(wire.headers.entries()),
    format: isFallback ? CC_ENDPOINT_TYPE : ENDPOINT_TYPE,
  }

  return { effective, wire: wireRequest }
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
