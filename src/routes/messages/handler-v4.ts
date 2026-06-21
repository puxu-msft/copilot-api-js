/**
 * v4 driver path for the Anthropic /v1/messages endpoint (P2.6 / C3b).
 *
 * The Anthropic route dispatches here (the v4 driver path — the only path since
 * P3.3 removed the legacy `handleMessages`). This is the "bypass-direct" format:
 * the codec's translate/render are identity, so the driver streams the upstream
 * Anthropic SSE frames through byte-for-byte and this handler reuses the
 * byte-critical pump primitives (streaming-pump.ts, shared with the retained
 * web_search direct-completion path) + the non-streaming finishing — only the
 * stream SOURCE changes (from `processAnthropicStream` to `driver.runResponse`,
 * with parse+accumulate+break
 * inlined; the idle/shutdown/client-abort guard is owned by the transport).
 *
 * Two route pre-steps stay on the legacy path by design (RFC §1 / §12.7):
 *   - warmup interception (`handleWarmupRequest`) — before any heavy processing.
 *   - web_search double-hop (`handleWebSearchCompletion`) — its own ctx, NOT the
 *     driver (the whole web_search feature is a deferred P2.6 item).
 *
 * P2-era division of labor (sampling sinks to the driver in P3.2): this handler
 * still owns the response-side sampling (sseEvents + forwarded SSE + accumulate +
 * complete/fail), the retry pipeline-info rebuild (`recordRetryPipelineStateV4`,
 * data sourced per RFC §12.4), and the verbose truncation marker. The client-facing
 * response rewrites (server-tool filter, tool-call-text recovery, tool-name restore,
 * tool-input decode) are driver-owned in BOTH modes (A1/A.B): streaming via the S5
 * per-frame chain, non-streaming via `driver.runResponseWhole` (`transformWhole`).
 */

import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"
import type { SSEStreamingApi } from "hono/streaming"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { AnthropicAutoTruncateResult } from "~/lib/anthropic/auto-truncate"
import type { AnthropicMessageResponse } from "~/lib/anthropic/client"
import type { SanitizationStats } from "~/lib/anthropic/sanitize"
import type {
  //
  HeadersCapture,
  RequestContext,
} from "~/lib/context/request"
import type {
  //
  PreprocessInfo,
  SseEventRecord,
} from "~/lib/history/store"
import type { Model } from "~/lib/models/client"
import type { FeatureKind } from "~/lib/observability"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  DriverRequestResult,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type {
  //
  MessagesPayload,
  StreamEvent,
} from "~/types/api/anthropic"

import { bridgeClientAbort } from "~/lib/abort-bridge"
import { supportsDirectAnthropicApi } from "~/lib/anthropic/features"
import { buildMessageMapping } from "~/lib/anthropic/message-mapping"
import { createBetaProbe } from "~/lib/anthropic/pipeline"
import {
  //
  preprocessAnthropicMessages,
  toSanitizationInfo,
} from "~/lib/anthropic/sanitize"
import { buildAnthropicToolNameMapper } from "~/lib/anthropic/sanitize/tool-name-sanitize"
import {
  //
  accumulateAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "~/lib/anthropic/stream-accumulator"
import {
  //
  handleWarmupRequest,
  isWarmupRequest,
} from "~/lib/anthropic/warmup"
import { payloadHasWebSearch } from "~/lib/anthropic/web-search/detect"
import { createAnthropicCodec } from "~/lib/codec/anthropic/codec"
import { ANTHROPIC_RESPONSE_REWRITES } from "~/lib/codec/anthropic/response-rewrites"
import { buildAnthropicStrategies } from "~/lib/codec/anthropic/strategies"
import { getRequestContextManager } from "~/lib/context/manager"
import { HTTPError } from "~/lib/error"
import { captureInboundHeaders } from "~/lib/fetch-utils"
import { getSessionIdFromHeaders } from "~/lib/history/store"
import { resolveModelName } from "~/lib/models/resolver"
import { makeSseSink } from "~/lib/pipeline/client-sink"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { createStreamRepetitionChecker } from "~/lib/repetition-detector"
import {
  //
  buildAnthropicResponseData,
  createTruncationMarker,
  prependMarkerToResponse,
} from "~/lib/request"
import { state } from "~/lib/state"
import { processAnthropicSystem } from "~/lib/system-prompt"
import { createUpstreamHttpTransport } from "~/lib/transport/http-transport"

import {
  //
  anthropicStreamErrorType,
  logUpstreamStreamError,
  recordUpstreamFrame,
  type StreamPumpState,
} from "./streaming-pump"
import { handleWebSearchCompletion } from "./web-search-handler"

/** Anthropic's effort-learning strategy is real (not inert); learning budget = 32 (legacy MAX_LEARNING_RETRIES). */
const MAX_LEARNING_RETRIES = 32

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Handle an Anthropic /v1/messages request via the v4 driver.
 *
 * Route pre-steps (parse is sync, so these stay here): warmup gate → model
 * resolve (BEFORE system-prompt's config reload, passed as `preResolved`) →
 * client-raw snapshot → async system-prompt injection → message preprocess →
 * web_search interception (legacy ctx, NOT driver) → driver bundle + runRequest.
 */
export async function handleMessagesV4(c: Context): Promise<Response> {
  const payload = await c.req.json<MessagesPayload>()

  // Warmup interception — before any heavy processing (model resolve, ctx). The
  // FULL legacy condition (RFC §12.7): `warmupPolicy !== "allow"` gates it, so a
  // policy of "allow" lets warmup requests flow through the normal path.
  if (state.warmupPolicy !== "allow" && isWarmupRequest(payload)) {
    // handleWarmupRequest returns a Response (streamSSE / c.json) or throws for the
    // reject policy; the union widens to `| undefined` only via an inference gap.
    return handleWarmupRequest(c, payload, state.warmupPolicy) as Response
  }

  // Resolve the model HERE (before processAnthropicSystem' config reload) and pass
  // it to parse as `preResolved`, matching the legacy handler's order (read model
  // → then system-prompt reload). Otherwise a `disabled_models` reload during
  // system-prompt would shift parse's model lookup vs. legacy.
  const clientModel = payload.model
  const resolvedName = resolveModelName(clientModel)
  const selectedModel = state.modelIndex.get(resolvedName)

  // Snapshot the client's raw inbound body BEFORE the system-prompt injection —
  // this is the history `originalBodyForHistory` (the codec records it as the
  // inboundRequest; the wire body below is the server-modified form).
  const clientRaw = structuredClone(payload)

  // System-prompt collection + config overrides (async, non-idempotent) on the
  // model-resolved wire body, BEFORE the sync codec.parse.
  const wireBody: MessagesPayload = { ...payload, model: resolvedName }
  if (wireBody.system) wireBody.system = await processAnthropicSystem(wireBody.system, resolvedName)

  // Phase 1: one-time message-level preprocessing (idempotent). The ctx's
  // toolNameMapper is NOT yet built here (that's codec.parse) — but
  // preprocessAnthropicMessages (dedup + strip-read-tags) does NOT depend on the
  // mapper (RFC §12.8), so running it pre-parse is safe. Do not move
  // mapper-dependent logic into this route pre-step.
  const pre = preprocessAnthropicMessages(wireBody.messages)
  wireBody.messages = pre.messages
  const preprocessInfo: PreprocessInfo = {
    strippedReadTagCount: pre.strippedReadTagCount,
    dedupedToolCallCount: pre.dedupedToolCallCount,
  }

  // Web search double-hop interception — stays on the legacy ctx + handler, NOT
  // the driver (RFC §1 / §12.7). Re-creates the legacy lightweight ctx (the codec
  // is bypassed entirely for this path).
  if (state.webSearchEnabled && payloadHasWebSearch(wireBody)) {
    // The web_search path bypasses the driver, so it ALSO bypasses the driver's
    // decideRoute route-validation. Replicate legacy's pre-ctx check here
    // (handler.ts: supportsDirectAnthropicApi runs before web_search) so an
    // unsupported model + web_search rejects identically (400) instead of
    // silently proceeding into the double-hop.
    const routing = supportsDirectAnthropicApi(resolvedName)
    if (!routing.supported) {
      const msg = `Model "${resolvedName}" does not support /v1/messages: ${routing.reason}`
      throw new HTTPError(msg, 400, msg)
    }
    consola.debug("[WebSearch] Intercepting request with native web_search tool (v4 route → legacy handler)")
    const reqCtx = createWebSearchContext(c, clientRaw, wireBody, resolvedName, clientModel, selectedModel)
    return handleWebSearchCompletion(c, wireBody, reqCtx, selectedModel, preprocessInfo)
  }

  return runMessagesDriver(c, { wireBody, clientRaw, resolvedName, selectedModel, preprocessInfo })
}

/**
 * Re-create the legacy lightweight RequestContext for the web_search double-hop
 * path (the codec is bypassed here). Mirrors `handleMessages`' ctx setup so the
 * web_search handler sees the same ctx shape it does on the legacy route.
 */
function createWebSearchContext(
  c: Context,
  clientRaw: MessagesPayload,
  wireBody: MessagesPayload,
  resolvedName: string,
  clientModel: string,
  selectedModel: Model | undefined,
): RequestContext {
  const clientModelName = clientModel !== resolvedName ? clientModel : undefined
  const manager = getRequestContextManager()
  const contentLengthHeader = c.req.header("content-length")
  const reqBodySize = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : undefined
  const reqCtx = manager.create({
    endpoint: "anthropic-messages",
    sessionId: getSessionIdFromHeaders(c.req.raw.headers),
    rawPath: c.req.path,
    method: c.req.method,
    path: c.req.path,
    ...(reqBodySize !== undefined && Number.isFinite(reqBodySize) && { requestBodySize: reqBodySize }),
  })
  c.set("requestContext", reqCtx)
  reqCtx.setOriginalRequest({
    model: clientModelName ?? clientRaw.model,
    messages: clientRaw.messages as unknown as Array<unknown>,
    stream: clientRaw.stream ?? false,
    tools: clientRaw.tools as unknown as Array<unknown> | undefined,
    system: clientRaw.system,
    payload: clientRaw,
  })
  reqCtx.setInboundRequestHeaders(captureInboundHeaders(c.req.raw.headers))
  reqCtx.setToolNameMapper(buildAnthropicToolNameMapper(wireBody.tools, resolvedName, selectedModel?.vendor))
  reqCtx.setResolvedModel({
    resolved: resolvedName,
    ...(clientModelName !== undefined && { client: clientModelName }),
  })
  return reqCtx
}

// ============================================================================
// Driver bundle + dispatch
// ============================================================================

interface RunMessagesDriverArgs {
  wireBody: MessagesPayload
  clientRaw: MessagesPayload
  resolvedName: string
  selectedModel: Model | undefined
  preprocessInfo: PreprocessInfo
}

async function runMessagesDriver(c: Context, args: RunMessagesDriverArgs): Promise<Response> {
  const { wireBody, clientRaw, resolvedName, preprocessInfo } = args

  const clientAbort = new AbortController()
  const detachClientAbort = bridgeClientAbort(c, clientAbort)
  const headersCapture: HeadersCapture = {}

  // betaProbe is a cross-component handle (RFC §2.4): the SAME instance is injected
  // into both the codec (records outbound betas in prepareWire) and the strategies
  // (unsupported-beta reads the candidates).
  const clientAnthropicBeta = c.req.raw.headers.get("anthropic-beta") ?? undefined
  const betaProbe = createBetaProbe(clientAnthropicBeta)
  const codec = createAnthropicCodec({ betaProbe, preprocessInfo })
  // rewriteShutdownAbort (C1 / H1): a shutdown-caused non-streaming fetch abort is
  // rewritten to a retryable 529 inside the send core, in the driver loop's place.
  const transport = createUpstreamHttpTransport({
    headersCapture,
    clientAbortSignal: clientAbort.signal,
    idleTimeoutMs: state.streamIdleTimeout * 1000,
    rewriteShutdownAbort: true,
  })

  // Truncation result for the response marker (captured from onMeta, post-gate).
  let truncateResult: AnthropicAutoTruncateResult | undefined

  const driver = createPipelineDriver({
    codec,
    transport,
    // S3 — the Anthropic request sanitize chain + its recordings, lifted from
    // codec.parse into a per-request RequestRewrite (RFC §4.A0). The codec owns them
    // (they close over preprocessInfo + write initialSanitizationInfo back).
    requestRewrites: codec.getRequestRewrites(),
    // S5 — the Anthropic response-rewrite chain (recover/thinking/decode/filter),
    // lifted from the handler's hand-nested pump into the driver (RFC §4.A1). The
    // driver applies + flushes them; the handler just forwards the yielded frames.
    responseRewrites: ANTHROPIC_RESPONSE_REWRITES,
    strategies: (env) => {
      // parse resolves the factory AFTER parse populated resanitize, so it is
      // present here; the guard is defensive (an unreachable parse failure would
      // have thrown before the factory runs).
      const resanitize = codec.getResanitize()
      if (!resanitize) throw new Error("[Anthropic:v4] resanitize chain unavailable — codec.parse did not run")
      return buildAnthropicStrategies({
        originalPayload: codec.getTruncateBaseline() ?? (env.body as MessagesPayload),
        resanitize,
        model: env.model as Model | undefined,
        maxRetries: state.autoTruncateMaxRetries,
        betaProbe,
      })
    },
    maxRetries: state.autoTruncateMaxRetries,
    maxLearningRetries: MAX_LEARNING_RETRIES,
    // Post-gate meta sink (C0-② / RFC §11.2 + §12.4): rebuild the retry pipeline-info
    // from the accepted retry's meta (sanitization / strippedBetas / probedBetas /
    // truncateResult) + the codec's sampleRequest-captured effective body. Only
    // fires after the budget gate accepts the retry — a budget-rejected retry never
    // emits phantom pipeline-info.
    onMeta: (meta, metaEnv) => {
      const rtr = meta.truncateResult as AnthropicAutoTruncateResult | undefined
      if (rtr) truncateResult = rtr
      recordRetryPipelineStateV4({ meta, env: metaEnv, codec, preprocessInfo })
    },
  })

  let result: DriverRequestResult
  try {
    result = await driver.runRequest({
      body: wireBody,
      originalBodyForHistory: clientRaw,
      headers: c.req.raw.headers,
      method: c.req.method,
      path: c.req.path,
      preResolved: { name: resolvedName, model: args.selectedModel },
      clientAbortSignal: clientAbort.signal,
    })
  } catch (error) {
    // Any failure after parse created the ctx (parse-period sanitize/translate
    // throw, or an exchange failure). Settle it (matching legacy's catch:
    // setHttpHeaders + fail) — `codec.getContext()` reaches the ctx even when the
    // throw happened before the envelope was otherwise capturable.
    const ctx = codec.getContext()
    if (ctx) {
      c.set("requestContext", ctx)
      ctx.setHttpHeaders(headersCapture)
      ctx.fail(resolvedName, error)
    }
    detachClientAbort()
    throw error
  }

  // Expose the ctx so the observability middleware's safety net can finalize it
  // from the HTTP status if a path below doesn't settle it (parity with legacy
  // c.set("requestContext")).
  const ctx = codec.getContext()
  if (ctx) c.set("requestContext", ctx)

  if (!result.ok) {
    // decideRoute reject (unsupported model) — shape the Anthropic 400. The route's
    // forwardError finishes the response; the middleware finalizes the now-c.set ctx
    // from the 4xx status (RFC §11.5 / §1 decision 3 — not a dangling entry).
    detachClientAbort()
    throw new HTTPError(result.rejection.reason, result.rejection.status, result.rejection.reason)
  }

  const { upstream, env } = result
  env.ctx.setHttpHeaders(headersCapture)

  if (!env.stream) {
    try {
      const resp = driver.runResponseNonStreaming(upstream, env) as AnthropicMessageResponse
      return renderNonStreamingV4(c, driver, env, resp, truncateResult)
    } finally {
      detachClientAbort()
    }
  }

  consola.debug("[Anthropic:v4] Streaming response")
  env.ctx.transition("streaming")
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => clientAbort.abort())
    try {
      await pumpAnthropicStreamingV4({ stream, driver, upstream, env, clientAbortSignal: clientAbort.signal })
    } finally {
      detachClientAbort()
    }
  })
}

// ============================================================================
// Retry pipeline-info rebuild (RFC §12.4 — data sourced per channel)
// ============================================================================

interface RecordRetryPipelineStateV4Args {
  meta: Record<string, unknown>
  env: RequestEnvelope
  codec: ReturnType<typeof createAnthropicCodec>
  preprocessInfo: PreprocessInfo
}

/**
 * Decide the single sticky feature tag implied by an accepted retry's `meta`
 * (or `null` for none). Pure so the gating is unit-testable in isolation —
 * the historical inline `else` unconditionally tagged `truncated`, which is
 * only correct for an auto-truncate retry. A beta-strip retry carries
 * `probedBetas`/`strippedBetas`; a truncate retry carries `truncateResult`
 * (passed in as `hasTruncateResult`); every other strategy's meta
 * (server-tool / structured-outputs / body-field / deferred-tool /
 * legacy-thinking / network / token-refresh) maps to NO feature tag.
 */
export function retryMetaFeature(meta: Record<string, unknown>, hasTruncateResult: boolean): { feature: FeatureKind; detail?: Record<string, unknown> } | null {
  const strippedBetas = (meta.probedBetas ?? meta.strippedBetas) as Array<string> | undefined
  if (strippedBetas && strippedBetas.length > 0) return { feature: "beta-stripped", detail: { betas: strippedBetas } }
  if (hasTruncateResult) return { feature: "truncated" }
  return null
}

/**
 * Rebuild `setPipelineInfo` + features for an accepted retry. Mirrors the legacy
 * `recordRetryPipelineState`, but the data comes from two channels (RFC §12.4):
 *   - message-mapping baseline ← `codec.getTruncateBaseline()` (preprocessed,
 *     pre-initial-sanitize); mapping effective ← `codec.getLatestEffectiveMessages()`
 *     (sampleRequest-captured, the `action.env.body === action.payload` invariant
 *     makes it the retry's body). (The `thinking` feature is NOT rebuilt here — it
 *     is emitted per-attempt by `prepareWire` as a terminal `{requested, effective}`
 *     dimension; see codec.ts / observability console sink.)
 *   - sanitization / strippedBetas / probedBetas / truncateResult ← `meta`
 *     (onMeta, post-gate).
 */
function recordRetryPipelineStateV4(args: RecordRetryPipelineStateV4Args): void {
  const { meta, codec, preprocessInfo } = args
  const ctx = codec.getContext()
  if (!ctx) return

  const baseline = codec.getTruncateBaseline()
  const effectiveMessages = codec.getLatestEffectiveMessages()

  const initialSanitizationInfo = codec.getInitialSanitizationInfo()
  const retrySanitization = meta.sanitization as SanitizationStats | undefined
  const allSanitization = [...(initialSanitizationInfo ? [initialSanitizationInfo] : []), ...(retrySanitization ? [toSanitizationInfo(retrySanitization)] : [])]

  const retryTruncateResult = meta.truncateResult as AnthropicAutoTruncateResult | undefined
  const retryMessageMapping =
    baseline && effectiveMessages ? buildMessageMapping(baseline.messages, effectiveMessages as MessagesPayload["messages"]) : undefined

  ctx.setPipelineInfo({
    preprocessing: preprocessInfo,
    sanitization: allSanitization,
    truncation:
      retryTruncateResult ?
        {
          wasTruncated: true,
          removedMessageCount: retryTruncateResult.removedMessageCount,
          originalTokens: retryTruncateResult.originalTokens,
          compactedTokens: retryTruncateResult.compactedTokens,
          processingTimeMs: retryTruncateResult.processingTimeMs,
        }
      : undefined,
    ...(retryMessageMapping && { messageMapping: retryMessageMapping }),
  })

  // Sticky feature tag for the accepted retry. Beta-strip and truncation are
  // NOT exhaustive — many strategies (server-tool / structured-outputs /
  // body-field / deferred-tool / legacy-thinking / network / token-refresh)
  // emit meta with neither signal, and must NOT be branded `truncated`.
  const retryFeature = retryMetaFeature(meta, retryTruncateResult !== undefined)
  if (retryFeature) ctx.recordFeature(retryFeature.feature, retryFeature.detail)
}

// ============================================================================
// Non-streaming render
// ============================================================================

/**
 * Finish a non-streaming Anthropic response: verbose marker (handler-side) → the driver's
 * whole-response rewrite chain (`runResponseWhole`: recover → decode → filter+restore, the
 * same registry the streaming pump drives per-frame, A.B) → setForwardedResponse (client-facing,
 * rewritten) + complete (upstream-original `response`, order matters) → c.json.
 *
 * The marker stays out of the registry (design §3.1 — it's a verbose debug banner, not an
 * "upstream-quirk fix") and is applied BEFORE the chain. `env.body` is the post-retry env
 * (deferred-tool retry's tools are reflected there) — the driver's rewrites read it via `env`.
 */
function renderNonStreamingV4(
  c: Context,
  driver: ReturnType<typeof createPipelineDriver>,
  env: RequestEnvelope,
  response: AnthropicMessageResponse,
  truncateResult: AnthropicAutoTruncateResult | undefined,
): Response {
  const reqCtx = env.ctx
  let finalResponse = response

  if (state.verbose && truncateResult?.wasTruncated) {
    const marker = createTruncationMarker(truncateResult)
    finalResponse = prependMarkerToResponse(response, marker)
  }

  finalResponse = driver.runResponseWhole(finalResponse, env) as AnthropicMessageResponse

  reqCtx.setForwardedResponse({ content: { role: "assistant", content: finalResponse.content } })
  reqCtx.complete({
    success: true,
    model: response.model,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? undefined,
    },
    stop_reason: response.stop_reason ?? undefined,
    content: { role: "assistant", content: response.content },
  })

  return c.json(finalResponse)
}

// ============================================================================
// Streaming pump (byte-critical primitives reused from streaming-pump.ts)
// ============================================================================

interface PumpAnthropicStreamingV4Options {
  stream: SSEStreamingApi
  driver: ReturnType<typeof createPipelineDriver>
  upstream: UpstreamStream
  env: RequestEnvelope
  clientAbortSignal: AbortSignal
}

/**
 * Stream pump for the v4 Anthropic path — **owns-the-sink** (Stage B Anthropic cut-over).
 * The driver now OWNS the client write-out: it applies the S5 response-rewrite chain
 * (recover/thinking/decode/filter via `ANTHROPIC_RESPONSE_REWRITES`) + `flushChain`, then
 * writes each REWRITTEN client frame to the injected {@link makeSseSink}, returning a
 * control-signal {@link import("~/lib/pipeline/types").ResponseOutcome}. This handler:
 *   - runs the upstream-side work (accumulate → outboundResponse, repetition, progress,
 *     diagnostics) on the RAW frame via the driver's `onUpstreamFrame` hook — BEFORE the
 *     rewrites (Option A / RFC §4.A1: keeps `outboundResponse` on the upstream-original),
 *   - samples the FORWARDED track INSIDE the sink (`onForwarded` → `forwardedSseEvents`):
 *     because the driver owns the write-out, the handler no longer sees each forwarded
 *     frame — the sink samples on `write` (real frames + the heartbeat ping), and the H3
 *     synthesized error frame goes through `sink.writeSynthetic` which does NOT sample
 *     (the H2-sampled / H3-unsampled asymmetry the B0-c golden locks),
 *   - maps the outcome + its own accumulator to the terminal ctx state (the driver holds
 *     no accumulator; H2 — a terminal upstream `error` frame — is a CLEAN drain, so the
 *     outcome is `complete` and `acc.streamError` is what flips it to `ctx.fail`).
 *
 * The transport's `guardSseIterable` owns idle/shutdown/client-abort (HARD kill); the
 * sink's heartbeat is a SEPARATE forward-idle racer (SOFT) — `runResponseSink`'s `finally`
 * calls `sink.close()` on every exit so its timer can't leak. `env.body` is the post-retry
 * env (C0-①): the recover/decode rewrites read `env.body.tools` so a deferred-tool retry's
 * modified tools are reflected (via `createState(env)`).
 */
async function pumpAnthropicStreamingV4(opts: PumpAnthropicStreamingV4Options): Promise<void> {
  const { stream, driver, upstream, env, clientAbortSignal } = opts
  const anthropicPayload = env.body as MessagesPayload
  const model = anthropicPayload.model

  const acc = createAnthropicStreamAccumulator()
  const checkRepetition = createStreamRepetitionChecker(model)

  // Raw upstream SSE frames (verbatim) — a local copy for logUpstreamStreamError. The
  // PERSISTED upstream-original track is the driver's (runResponse loop-top, P3.2b).
  const sseEvents: Array<SseEventRecord> = []
  // Forwarded SSE frames — what the client ACTUALLY received (post-S5-rewrite). Filled by
  // the sink's `onForwarded` sampler (real frames + heartbeat ping), NOT the H3 synth error.
  const forwardedSseEvents: Array<SseEventRecord> = []

  const streamState: StreamPumpState = {
    streamStartMs: Date.now(),
    bytesIn: 0,
    eventsIn: 0,
    currentBlockType: "",
    firstEventLogged: false,
    recoverFeatureLogged: false,
  }

  // Upstream-side work on the RAW frame (BEFORE the S5 rewrites): parse + accumulate
  // (→ outboundResponse, upstream-original) + the shared recording (sseEvents,
  // progress, repetition, server-tool logging). A malformed frame is logged but not
  // fatal (RFC §12.6) — still recorded with parsed=undefined.
  const onUpstreamFrame = (frame: UpstreamFrame): void => {
    const rawEvent = frame as ServerSentEventMessage
    let parsed: StreamEvent | undefined
    if (rawEvent.data) {
      try {
        parsed = JSON.parse(rawEvent.data) as StreamEvent
        accumulateAnthropicStreamEvent(parsed, acc)
      } catch (error) {
        consola.error("Failed to parse Anthropic stream event:", error, rawEvent.data)
      }
    }
    recordUpstreamFrame({ rawEvent, parsed, streamState, sseEvents, reqCtx: env.ctx, checkRepetition })
  }

  // The driver-owned client sink: SSE write-out + forwarded sampling + (optional) the
  // fake_sse_heartbeat forward-idle racer. Heartbeats are proxy-originated: sampled ONLY
  // into forwardedSseEvents (via onForwarded), never sseEvents (the driver's raw track).
  const sink = makeSseSink(stream, {
    onForwarded: (record) => forwardedSseEvents.push(record),
    streamStartMs: streamState.streamStartMs,
    ...(state.anthropicFakeSseHeartbeat > 0 && {
      heartbeat: {
        intervalSec: state.anthropicFakeSseHeartbeat,
        pingFrame: { event: "ping", data: JSON.stringify({ type: "ping" }) },
        clientAbortSignal,
      },
    }),
  })

  // Snapshot the forwarded track onto the ctx (R3-④: forwardedSseEvents is aliased by
  // entry.inboundResponse — `close()` in runResponseSink's finally already stopped the
  // heartbeat, but a fresh copy is the durable guard against a late ping mutating it).
  const recordForwarded = (): void => env.ctx.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })

  // The driver drives the S5 chain + writes the rewritten frames to the sink; `[DONE]` is
  // dropped inside runResponseSink (Anthropic emits no trailing terminator). The outcome
  // is the format-agnostic control signal; the handler reads its own `acc` for the rest.
  const outcome = await driver.runResponseSink(upstream, env, sink, { onUpstreamFrame })

  if (outcome.kind === "settled-abort") {
    // Client disconnected mid-stream — the stream is dead, write ZERO further bytes
    // (B0-d). Record what was forwarded so far, then settle as aborted.
    recordForwarded()
    consola.debug("[Stream] Client disconnected mid-stream — recording aborted")
    env.ctx.abort(acc.model || model, { usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens }, stop_reason: acc.stopReason || undefined })
    return
  }

  recordForwarded()

  if (outcome.kind === "stream-error") {
    // H3 — the upstream iterable (or a sink write) threw a non-abort error. Settle as
    // fail (with the partial accumulated so far) + synthesize the Anthropic error frame
    // through the NON-sampling writeSynthetic path (so H3 never enters the forwarded track).
    const error = outcome.error
    env.ctx.fail(acc.model || model, error, {
      usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens },
      stop_reason: acc.stopReason || undefined,
    })
    logUpstreamStreamError(error, { model: acc.model || model, streamState, acc, sseEvents })
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorType = anthropicStreamErrorType(error)
    await sink.writeSynthetic?.({ event: "error", data: JSON.stringify({ type: "error", error: { type: errorType, message: errorMessage } }) })
    return
  }

  // outcome.kind === "complete" — the upstream drained cleanly.
  const summaryParts = [`↓${streamState.bytesIn}B ${streamState.eventsIn}ev in ${Date.now() - streamState.streamStartMs}ms`]
  if (acc.toolSearchRequests > 0) summaryParts.push(`tool_search:${acc.toolSearchRequests}`)
  consola.debug(`[Stream] Completed: ${summaryParts.join(" ")}`)

  if (acc.streamError) {
    // H2 — a terminal upstream `error` SSE event was forwarded as a content frame (clean
    // drain, never a thrown error → outcome is `complete`); settle as fail from the acc.
    consola.error(`[Stream] Upstream error for ${acc.model || model}: ${acc.streamError.type} — ${acc.streamError.message}`)
    env.ctx.fail(acc.model || model, new Error(`${acc.streamError.type}: ${acc.streamError.message}`))
  } else {
    env.ctx.complete(buildAnthropicResponseData(acc, model))
  }
}
