/**
 * v4 driver path for the Anthropic /v1/messages endpoint (P2.6 / C3b).
 *
 * The route switches to this behind the `anthropic` feature flag (driver-flags);
 * the legacy `handleMessages` stays in use when the flag is off (default). This is
 * the "bypass-direct" format: the codec's translate/render are identity, so the
 * driver streams the upstream Anthropic SSE frames through byte-for-byte and this
 * handler reuses the legacy byte-critical pump primitives (streaming-pump.ts) +
 * the legacy non-streaming finishing — only the stream SOURCE changes (from
 * `processAnthropicStream` to `driver.runResponse`, with parse+accumulate+break
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
 * data sourced per RFC §12.4), and the client-facing finishing the codec does NOT
 * do (server-tool filter, tool-call-text recovery, tool-name restore, tool-input
 * decode, the verbose truncation marker).
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
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  DriverRequestResult,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type {
  //
  MessagesPayload,
  StreamEvent,
} from "~/types/api/anthropic"

import { bridgeClientAbort } from "~/lib/abort-bridge"
import {
  //
  createToolInputStreamDecoder,
  decodeToolInputBlocksInResponse,
} from "~/lib/anthropic/decode-tool-input"
import { supportsDirectAnthropicApi } from "~/lib/anthropic/features"
import { buildMessageMapping } from "~/lib/anthropic/message-mapping"
import { createBetaProbe } from "~/lib/anthropic/pipeline"
import {
  //
  createToolCallTextRecoverer,
  extractToolParamTypes,
  recoverToolCallTextInResponse,
} from "~/lib/anthropic/recover-tool-call"
import {
  //
  preprocessAnthropicMessages,
  toSanitizationInfo,
} from "~/lib/anthropic/sanitize"
import { buildAnthropicToolNameMapper } from "~/lib/anthropic/sanitize/tool-name-sanitize"
import {
  //
  createServerToolBlockFilter,
  filterServerToolBlocksFromResponse,
  logServerToolBlocks,
  restoreToolNamesInResponse,
} from "~/lib/anthropic/server-tool-filter"
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
import { createAnthropicCodec } from "~/lib/codec/anthropic"
import { buildAnthropicStrategies } from "~/lib/codec/anthropic-strategies"
import { getRequestContextManager } from "~/lib/context/manager"
import { HTTPError } from "~/lib/error"
import { captureInboundHeaders } from "~/lib/fetch-utils"
import { getSessionIdFromHeaders } from "~/lib/history/store"
import { resolveModelName } from "~/lib/models/resolver"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { createStreamRepetitionChecker } from "~/lib/repetition-detector"
import {
  //
  buildAnthropicResponseData,
  createTruncationMarker,
  prependMarkerToResponse,
} from "~/lib/request"
import { settleStreamingFailure } from "~/lib/request/stream-settle"
import { state } from "~/lib/state"
import { processAnthropicSystem } from "~/lib/system-prompt"
import { createUpstreamHttpTransport } from "~/lib/transport/http-transport"

import {
  //
  anthropicStreamErrorType,
  forwardToClient,
  logUpstreamStreamError,
  parseStreamEventData,
  processOneStreamEvent,
  startForwardedSseHeartbeat,
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
      return renderNonStreamingV4(c, env, resp, truncateResult)
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
 * Rebuild `setPipelineInfo` + features for an accepted retry. Mirrors the legacy
 * `recordRetryPipelineState`, but the data comes from two channels (RFC §12.4):
 *   - message-mapping baseline ← `codec.getTruncateBaseline()` (preprocessed,
 *     pre-initial-sanitize); mapping effective + `thinking` feature ←
 *     `codec.getLatestEffectiveMessages/Thinking()` (sampleRequest-captured, the
 *     `action.env.body === action.payload` invariant makes them the retry's body).
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

  // Beta retries surface which betas were stripped this attempt as a sticky feature
  // tag; truncation is a sticky feature tag (mutually exclusive in legacy).
  const strippedBetas = (meta.probedBetas ?? meta.strippedBetas) as Array<string> | undefined
  if (strippedBetas && strippedBetas.length > 0) {
    ctx.recordFeature("beta-stripped", { betas: strippedBetas })
  } else {
    ctx.recordFeature("truncated")
  }

  // `thinking` feature ← the retry's effective body (sampleRequest closure, NOT
  // meta — RFC §12.4 easy-to-miss point).
  const effectiveThinking = codec.getLatestEffectiveThinking() as { type?: string } | undefined
  if (effectiveThinking && effectiveThinking.type !== "disabled") {
    ctx.recordFeature("thinking", { type: effectiveThinking.type })
  }
}

// ============================================================================
// Non-streaming render
// ============================================================================

/**
 * Reproduce the legacy `handleDirectAnthropicNonStreamingResponse` sequence:
 * verbose marker → server-tool filter → recover-tool-call-text (BEFORE
 * restoreToolNames) → restore tool-names → decode tool-input → setForwardedResponse
 * (client-facing) + complete (upstream-original, order matters). `env.body` is the
 * post-retry env (deferred-tool retry's tools are reflected there).
 */
function renderNonStreamingV4(
  c: Context,
  env: RequestEnvelope,
  response: AnthropicMessageResponse,
  truncateResult: AnthropicAutoTruncateResult | undefined,
): Response {
  const reqCtx = env.ctx
  const anthropicPayload = env.body as MessagesPayload
  let finalResponse = response

  if (state.verbose && truncateResult?.wasTruncated) {
    const marker = createTruncationMarker(truncateResult)
    finalResponse = prependMarkerToResponse(response, marker)
  }

  logServerToolBlocks(finalResponse.content as unknown as Array<Record<string, unknown> & { type: string }>)
  finalResponse = filterServerToolBlocksFromResponse(finalResponse)

  finalResponse = recoverToolCallTextInResponse(finalResponse, {
    enabled: state.recoverToolCallText,
    toolNames: new Set((anthropicPayload.tools ?? []).map((t) => t.name)),
    toolSchemas: extractToolParamTypes(anthropicPayload.tools),
  })

  finalResponse = restoreToolNamesInResponse(finalResponse, reqCtx.toolNameMapper)

  finalResponse = decodeToolInputBlocksInResponse(
    finalResponse,
    {
      fields: state.decodeToolInputFields,
      all: state.decodeAllToolInputFields,
    },
    { backfillAskUserQuestionHeader: state.backfillQuestionFromHeader },
  )

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
 * Stream pump for the v4 Anthropic path. Sets up the same per-request state as the
 * legacy `handleDirectAnthropicStreamingResponse` (accumulator + repetition checker
 * + server-tool filter + tool-input decoder + tool-call-text recoverer + heartbeat),
 * then drives `driver.runResponse` (identity → upstream Anthropic SSE frames) with
 * the legacy parse+accumulate+break inlined.
 *
 * The transport's `guardSseIterable` already owns idle/shutdown/client-abort, so
 * this inline loop does NOT add a second guard (RFC §10.6 — avoids double abort
 * listeners). `env.body` is the post-retry env (C0-① / RFC §11.1): the recoverer
 * reads `env.body.tools` so deferred-tool retry's modified tools are reflected.
 */
async function pumpAnthropicStreamingV4(opts: PumpAnthropicStreamingV4Options): Promise<void> {
  const { stream, driver, upstream, env, clientAbortSignal } = opts
  const anthropicPayload = env.body as MessagesPayload
  const model = anthropicPayload.model

  const acc = createAnthropicStreamAccumulator()
  const checkRepetition = createStreamRepetitionChecker(model)

  // Raw upstream SSE frames (verbatim, incl. keepalives) for history.
  const sseEvents: Array<SseEventRecord> = []
  // Forwarded SSE frames — what the client ACTUALLY received after filtering /
  // restoration / decoding. Compared against `sseEvents` = sent-vs-received.
  const forwardedSseEvents: Array<SseEventRecord> = []

  const serverToolFilter = createServerToolBlockFilter(env.ctx.toolNameMapper)

  const toolInputDecoder = createToolInputStreamDecoder(
    {
      fields: state.decodeToolInputFields,
      all: state.decodeAllToolInputFields,
    },
    { backfillAskUserQuestionHeader: state.backfillQuestionFromHeader },
  )

  // Tool-call-text recoverer reads the POST-retry env body's tools (C0-①) — a
  // deferred-tool retry that changed `tools` is reflected here, so the synthesized
  // tool_use names/schemas match what was actually sent.
  const toolCallTextRecoverer = createToolCallTextRecoverer({
    enabled: state.recoverToolCallText,
    toolNames: new Set((anthropicPayload.tools ?? []).map((t) => t.name)),
    toolSchemas: extractToolParamTypes(anthropicPayload.tools),
  })

  const streamState: StreamPumpState = {
    streamStartMs: Date.now(),
    bytesIn: 0,
    eventsIn: 0,
    currentBlockType: "",
    firstEventLogged: false,
    recoverFeatureLogged: false,
  }

  // Synthetic SSE keepalive (anthropic.fake_sse_heartbeat). Heartbeats are
  // proxy-originated: recorded ONLY in forwardedSseEvents, never sseEvents. The
  // clientAbortSignal lets the heartbeat tick skip emitting after a client abort.
  const heartbeat = startForwardedSseHeartbeat({
    intervalSec: state.anthropicFakeSseHeartbeat,
    stream,
    forwardedSseEvents,
    streamState,
    clientAbortSignal,
  })

  try {
    // driver.runResponse yields the upstream Anthropic SSE frames byte-for-byte
    // (renderResponse is identity). Inline the legacy processAnthropicStream's
    // parse+accumulate+break (the guard is the transport's, not re-added here).
    for await (const frame of driver.runResponse(upstream, env)) {
      const rawEvent = frame as ServerSentEventMessage

      // Keepalive (no data): forward as-is, no parse/accumulate.
      if (!rawEvent.data) {
        await processOneStreamEvent({
          rawEvent,
          parsed: undefined,
          streamState,
          sseEvents,
          forwardedSseEvents,
          reqCtx: env.ctx,
          checkRepetition,
          serverToolFilter,
          toolInputDecoder,
          toolCallTextRecoverer,
          heartbeat,
        })
        continue
      }

      if (rawEvent.data === "[DONE]") break

      let parsed: StreamEvent | undefined
      try {
        parsed = JSON.parse(rawEvent.data) as StreamEvent
        accumulateAnthropicStreamEvent(parsed, acc)
      } catch (error) {
        // Defensive (RFC §12.6, matching processAnthropicStream): a malformed frame
        // is logged but NOT fatal — still forward it (parsed=undefined), don't break,
        // don't fail.
        consola.error("Failed to parse Anthropic stream event:", error, rawEvent.data)
      }

      await processOneStreamEvent({
        rawEvent,
        parsed,
        streamState,
        sseEvents,
        forwardedSseEvents,
        reqCtx: env.ctx,
        checkRepetition,
        serverToolFilter,
        toolInputDecoder,
        toolCallTextRecoverer,
        heartbeat,
      })

      // H2 (RFC §11.4): a terminal upstream `error` SSE frame is forwarded EXACTLY
      // once (above) THEN breaks — yield-then-break, not break-then-drop. The
      // post-loop `acc.streamError` branch settles it as fail (not a thrown error).
      if (parsed?.type === "error") break
    }

    // Flush any tool_use input the recoverer/decoder buffered (defensive — normal
    // completion emits content_block_stop). Recoverer first, then decoder.
    for (const rev of toolCallTextRecoverer.flush()) {
      const rp = parseStreamEventData(rev.data)
      for (const ev of toolInputDecoder.processEvent(rp, rev)) {
        await forwardToClient(ev, ev === rev ? rp : undefined, serverToolFilter, forwardedSseEvents, streamState.streamStartMs, heartbeat)
      }
    }
    for (const ev of toolInputDecoder.flush()) {
      await forwardToClient(ev, undefined, serverToolFilter, forwardedSseEvents, streamState.streamStartMs, heartbeat)
    }

    const summaryParts = [`↓${streamState.bytesIn}B ${streamState.eventsIn}ev in ${Date.now() - streamState.streamStartMs}ms`]
    if (acc.toolSearchRequests > 0) summaryParts.push(`tool_search:${acc.toolSearchRequests}`)
    consola.debug(`[Stream] Completed: ${summaryParts.join(" ")}`)

    env.ctx.setSseEvents(sseEvents)
    env.ctx.setForwardedResponse({ sseEvents: forwardedSseEvents })

    if (acc.streamError) {
      // Terminal upstream `error` SSE event (H2) — not a thrown failure, so it never
      // reaches the catch. Log + fail here (mirrors the catch block's console.error).
      consola.error(`[Stream] Upstream error for ${acc.model || model}: ${acc.streamError.type} — ${acc.streamError.message}`)
      env.ctx.fail(acc.model || model, new Error(`${acc.streamError.type}: ${acc.streamError.message}`))
    } else {
      env.ctx.complete(buildAnthropicResponseData(acc, model))
    }
  } catch (error) {
    // Record what was streamed/forwarded so far BEFORE settling (原则3).
    env.ctx.setSseEvents(sseEvents)
    env.ctx.setForwardedResponse({ sseEvents: forwardedSseEvents })

    const partial = { usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens }, stop_reason: acc.stopReason || undefined }
    if (settleStreamingFailure({ reqCtx: env.ctx, error, model: acc.model || model, partial })) {
      consola.debug("[Stream] Client disconnected mid-stream — recording aborted")
      return
    }

    logUpstreamStreamError(error, { model: acc.model || model, streamState, acc, sseEvents })

    // H3 (RFC §10.4): best-effort flush of buffered tool_use deltas BEFORE the error
    // frame, so the client doesn't silently lose fragments the decoder was holding.
    // The stream may already be broken (abort/shutdown); ignore failures here.
    try {
      for (const rev of toolCallTextRecoverer.flush()) {
        const rp = parseStreamEventData(rev.data)
        for (const ev of toolInputDecoder.processEvent(rp, rev)) {
          await forwardToClient(ev, ev === rev ? rp : undefined, serverToolFilter, forwardedSseEvents, streamState.streamStartMs, heartbeat)
        }
      }
      for (const ev of toolInputDecoder.flush()) {
        await forwardToClient(ev, undefined, serverToolFilter, forwardedSseEvents, streamState.streamStartMs, heartbeat)
      }
    } catch {
      // stream already closed — nothing to recover
    }

    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorType = anthropicStreamErrorType(error)
    await heartbeat.writeSerialized({
      event: "error",
      data: JSON.stringify({ type: "error", error: { type: errorType, message: errorMessage } }),
    })
  } finally {
    heartbeat.stop()
  }
}
