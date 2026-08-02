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
 * One route pre-step stays on the legacy path by design (RFC §1 / §12.7):
 *   - warmup interception (`handleWarmupRequest`) — before any heavy processing.
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
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { AnthropicMessageResponse } from "~/lib/anthropic/client"
import type { SanitizationStats } from "~/lib/anthropic/sanitize"
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
  AnchorHooks,
  AnchorState,
  ClientFrame,
  ClientSink,
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
  extractAppliedEdits,
  summarizeAppliedEdits,
} from "~/lib/anthropic/applied-context-edits"
import { extractAnthropicCommittedBlocks } from "~/lib/anthropic/committed-block-extractor"
import { registerAnthropicContinuationBuilder } from "~/lib/anthropic/continuation-builder"
import { selectForwardableResponseHeaders } from "~/lib/anthropic/header-policy"
import {
  //
  anchorDeltaFrame,
  anchorStartFrame,
  anchorStopFrame,
  closeAnchorIfOpen,
  createGenerationWireIndexAllocator,
  createGenerationWireState,
  isAnthropicContentBlockStart,
  isAnthropicMessageStart,
  makeSyntheticAnchorInjector,
  makeSyntheticEnvelopeInjector,
  remapAnthropicBlockIndex,
  syntheticMessageStartFrame,
} from "~/lib/anthropic/keepalive-anchor"
import {
  //
  ANTHROPIC_PING,
  makeAnthropicKeepaliveFrame,
  resolveAnthropicKeepalive,
} from "~/lib/anthropic/keepalive-frame"
import { makeReconcilingSink } from "~/lib/anthropic/live-reconcile"
import { buildMessageMapping } from "~/lib/anthropic/message-mapping"
import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { recordProtectStreamingOutcome } from "~/lib/anthropic/protect-streaming-stats"
import {
  //
  extractRefusalDetail,
  refusalCategoryForDiagnostics,
  hasClientVisibleContent,
  isContentlessRefusal,
  refusalSummary,
  type RefusalMode,
  refusalVarsFromResponse,
  renderRefusalTemplate,
} from "~/lib/anthropic/recover-refusal"
import {
  //
  preprocessAnthropicMessages,
  toSanitizationInfo,
} from "~/lib/anthropic/sanitize"
import {
  //
  accumulateAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "~/lib/anthropic/stream-accumulator"
import { flushToolInputRepairObservability } from "~/lib/anthropic/tool-input-repair-stats"
import {
  //
  handleWarmupRequest,
  isWarmupRequest,
} from "~/lib/anthropic/warmup"
import { createAnthropicCodec } from "~/lib/codec/anthropic/codec"
import { anthropicCommitBoundaries } from "~/lib/codec/anthropic/commit-boundaries"
import { applyConfigToState } from "~/lib/config/config"
import {
  //
  resolveBufferedCaps,
  resolveContinuation,
} from "~/lib/config/model-overrides"
import {
  //
  HTTPError,
  isAbortError,
} from "~/lib/error"
import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  resolveModelTarget,
  type RouteOverride,
} from "~/lib/models/resolver"
import { resolveStreamIdleTimeoutMs } from "~/lib/models/timeout-resolver"
import { recordAbortProvenanceGap } from "~/lib/observability/abort-provenance-gaps"
import {
  //
  accumulateResponsesStreamEvent,
  createResponsesStreamAccumulator,
} from "~/lib/openai/responses-stream-accumulator"
import {
  //
  accumulateOpenAIStreamEvent,
  createOpenAIStreamAccumulator,
} from "~/lib/openai/stream-accumulator"
import { makeDeliverySseSink } from "~/lib/pipeline/client-sink"
import { createCommittedBlocksLedger } from "~/lib/pipeline/committed-blocks-ledger"
import { getContinuationBuilder } from "~/lib/pipeline/continuation-request-builder"
import { getDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import {
  //
  createCandidateResponseSession,
  type CandidateResponseSession,
  type CandidateResponseSessionFactory,
} from "~/lib/pipeline/generation/candidate-response-session"
import { createRuntimeHedgePolicy } from "~/lib/pipeline/generation/runtime-policy"
import {
  //
  createTerminalObserver,
  updateAnthropicTerminalObserver,
} from "~/lib/pipeline/max-tokens-terminal-observer"
import {
  //
  classifyMaxTokensTruncation,
  isAnthropicMaxTokensTerminal,
} from "~/lib/pipeline/max-tokens-truncation-class"
import { anthropicNonStreamingTruncation } from "~/lib/pipeline/non-streaming-completeness"
import { clientFirstRealSinkOpts } from "~/lib/pipeline/request-timing"
import { createStreamRepetitionChecker } from "~/lib/repetition-detector"
import {
  //
  buildAnthropicResponseData,
  buildOpenAIResponseData,
  buildResponsesResponseData,
} from "~/lib/request"
import { state } from "~/lib/state"
import { createUpstreamHttpTransport } from "~/lib/transport/http-transport"
import { resolveInboundQuery } from "~/lib/transport/query-forward"
import {
  //
  createUpstreamFrameDiagnostics,
  logUpstreamStreamOutcomeError,
  logUpstreamStreamTruncation,
} from "~/lib/upstream-stream-diagnostics"

import {
  //
  shapePostcommitErrorFrame,
  shapeRawStreamErrorFrame,
} from "./error-shaping-glue"
import {
  //
  anthropicErrorFrame,
  anthropicHttpErrorFrame,
  anthropicRejectErrorFrame,
  classifyPostCommitAbort,
  postCommitAbortFrame,
} from "./post-commit-error"
import { retryMetaFeature } from "./retry-meta-feature"
import {
  //
  anthropicStreamErrorType,
  recordUpstreamFrame,
  type StreamPumpState,
} from "./streaming-pump"

/** Anthropic's effort-learning strategy is real (not inert); learning budget = 32 (legacy MAX_LEARNING_RETRIES). */
const MAX_LEARNING_RETRIES = 32

/** L2 escalation floor: the most aggressive `clear_tool_uses` input-token trigger we'll set on a retry. */
const ESCALATE_MIN_TRIGGER = 4096

// Register the Anthropic continuation-request builder once at module load, so `getContinuationBuilder`
// resolves it in the buffered opts below (spec 2026-07-22 §4.3). Idempotent (a Map set).
registerAnthropicContinuationBuilder()

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
type AnthropicCandidateResponseSnapshot =
  | Readonly<{
      kind: "anthropic-direct"
      acc: ReturnType<typeof createAnthropicStreamAccumulator>
      terminalObserver: ReturnType<typeof createTerminalObserver>
      sseEvents: Array<SseEventRecord>
      streamState: StreamPumpState
    }>
  | Readonly<{
      kind: "anthropic-translate"
      ccAcc: ReturnType<typeof createOpenAIStreamAccumulator> | undefined
      respAcc: ReturnType<typeof createResponsesStreamAccumulator> | undefined
      diag: ReturnType<typeof createUpstreamFrameDiagnostics>
      meta: ReturnType<ReturnType<typeof createAnthropicCodec>["getStreamMeta"]>
    }>

const createAnthropicCandidateResponseSession: CandidateResponseSessionFactory = (input) => {
  const startedAtMs = Date.now()
  const model = (input.env.body as { model?: string }).model ?? "unknown"
  if (input.env.targetEndpoint === ENDPOINT.MESSAGES) {
    return createCandidateResponseSession({
      ...input,
      createState: () => ({
        acc: createAnthropicStreamAccumulator(),
        terminalObserver: createTerminalObserver(),
        checkRepetition: createStreamRepetitionChecker(model),
        sseEvents: [] as Array<SseEventRecord>,
        streamState: {
          streamStartMs: startedAtMs,
          bytesIn: 0,
          eventsIn: 0,
          currentBlockType: "",
          firstEventLogged: false,
          recoverFeatureLogged: false,
        } satisfies StreamPumpState,
      }),
      onUpstreamFrame(state, frame) {
        const rawEvent = frame as ServerSentEventMessage
        let parsed: StreamEvent | undefined
        if (rawEvent.data) {
          try {
            parsed = JSON.parse(rawEvent.data) as StreamEvent
            accumulateAnthropicStreamEvent(parsed, state.acc)
          } catch (error) {
            consola.error("Failed to parse Anthropic stream event:", error, rawEvent.data)
          }
        }
        recordUpstreamFrame({
          rawEvent,
          parsed,
          streamState: state.streamState,
          sseEvents: state.sseEvents,
          reqCtx: input.env.ctx,
          checkRepetition: state.checkRepetition,
        })
      },
      onRenderedFrame(state, frame) {
        if (typeof frame.data === "string") {
          try {
            updateAnthropicTerminalObserver(
              state.terminalObserver,
              JSON.parse(frame.data) as { type: string; index?: number; content_block?: { type: string } },
            )
          } catch {
            // Non-JSON SSE frames (for example ping) do not contain Anthropic block state.
          }
        }
        return frame
      },
      sawMessageStop: (state) => state.acc.sawMessageStop,
      sawUpstreamError: (state) => state.acc.streamError !== undefined,
      // A contentless refusal is a terminal upstream decision even without `message_stop` — see the
      // driver's commit gate. Kept separate from `sawUpstreamError` because that predicate also
      // drives the error-terminus flush path, which a refusal must not enter.
      sawContentlessRefusal: (state) => isContentlessRefusal(state.acc.stopReason, hasClientVisibleContent(state.acc.contentBlocks)),
      onBufferedResolve(state, outcome, retries, meta) {
        if (outcome === "success" && retries === 0) return
        recordProtectStreamingOutcome(outcome, retries, meta)
        input.env.ctx.recordFeature("protect-streaming-retry", { outcome, retries, vendor: meta.vendor })
        consola.debug(`[protect-stream] ${outcome} for ${state.acc.model || model} after ${retries} retr${retries === 1 ? "y" : "ies"}`)
      },
      snapshot: (state) => ({
        kind: "anthropic-direct" as const,
        acc: state.acc,
        terminalObserver: state.terminalObserver,
        sseEvents: state.sseEvents,
        streamState: state.streamState,
      }),
    })
  }

  return createCandidateResponseSession({
    ...input,
    createState: () => ({
      ccAcc: input.env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS ? createOpenAIStreamAccumulator() : undefined,
      respAcc: input.env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS ? undefined : createResponsesStreamAccumulator(),
      diag: createUpstreamFrameDiagnostics(startedAtMs),
    }),
    onUpstreamFrame(state, frame) {
      const rawEvent = frame as ServerSentEventMessage
      state.diag.observe(rawEvent)
      if (!rawEvent.data || rawEvent.data === "[DONE]") return
      try {
        const parsed = JSON.parse(rawEvent.data) as Record<string, unknown>
        if (state.ccAcc) accumulateOpenAIStreamEvent(parsed as never, state.ccAcc)
        else if (state.respAcc) accumulateResponsesStreamEvent(parsed as never, state.respAcc)
      } catch (error) {
        consola.error("[Anthropic:v4:translate] Failed to parse upstream stream event:", error, rawEvent.data)
      }
    },
    finish(_state, renderer, rendererFrames) {
      const meta = renderer.getStreamMeta?.() as { stopReason?: string } | undefined
      if (meta?.stopReason === undefined) {
        return {
          kind: "truncated",
          frames: rendererFrames.filter((frame) => !isMessageTerminatorFrame(frame)),
          reason: "Upstream stream truncated before completion (no finish_reason)",
        }
      }
      return { kind: "complete", frames: rendererFrames }
    },
    snapshot: (state, renderer) => ({ kind: "anthropic-translate" as const, ...state, meta: renderer.getStreamMeta?.() }),
  })
}

function anthropicCandidateSnapshot(driver: ReturnType<typeof createPipelineDriver>, upstream: UpstreamStream): AnthropicCandidateResponseSnapshot {
  const session = driver.getCandidateResponseSession(upstream) as CandidateResponseSession<AnthropicCandidateResponseSnapshot> | undefined
  if (!session) throw new Error("[Anthropic:v4] candidate response session missing")
  return session.snapshot()
}

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
  const { name: resolvedName, routeOverride } = resolveModelTarget(clientModel)
  const selectedModel = state.modelIndex.get(resolvedName)

  // Snapshot the client's raw inbound body BEFORE the system-prompt injection —
  // this is the history `originalBodyForHistory` (the codec records it as the
  // inboundRequest; the wire body below is the server-modified form).
  const clientRaw = structuredClone(payload)

  // System-prompt injection (async, non-idempotent) has moved OFF the route into the anthropic
  // codec's S1b `translateInbound` (RFC 2026-07-14 §4) so `client.inbound` (Phase 4) sees the
  // client-native `system`. Config freshness stays a route concern: anthropic parse reads
  // config-managed state (`state.sanitizeToolNames` → the tool-name mapper), and the legacy flow
  // reloaded config before parse ONLY when a system was present (processAnthropicSystem early-returns
  // otherwise) — so this reload is guarded on `payload.system` to preserve that exact conditionality
  // (an unconditional reload would reset config state that system-less tests set up). Model resolved
  // just above, before the reload — legacy order preserved.
  const wireBody: MessagesPayload = { ...payload, model: resolvedName }
  if (payload.system) await applyConfigToState()

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

  return runMessagesDriver(c, { wireBody, clientRaw, resolvedName, selectedModel, preprocessInfo, ...(routeOverride && { routeOverride }) })
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
  /** The client's explicit `@cc/@responses/@messages` leg pin, threaded to the driver via `preResolved`. */
  routeOverride?: RouteOverride
}

async function runMessagesDriver(c: Context, args: RunMessagesDriverArgs): Promise<Response> {
  const { wireBody, clientRaw, resolvedName, preprocessInfo } = args

  const clientAbort = new AbortController()
  const detachClientAbort = bridgeClientAbort(c, clientAbort)

  // betaProbe is a cross-component handle (RFC §2.4): the SAME instance is injected
  // into both the codec (records outbound betas in prepareWire) and the strategies
  // (unsupported-beta reads the candidates).
  const clientAnthropicBeta = c.req.raw.headers.get("anthropic-beta") ?? undefined
  const betaProbe = createBetaProbe(clientAnthropicBeta)
  const codec = createAnthropicCodec({ betaProbe, preprocessInfo })
  // rewriteShutdownAbort (C1 / H1): a shutdown-caused non-streaming fetch abort is
  // rewritten to a retryable 529 inside the send core, in the driver loop's place.
  const transport = createUpstreamHttpTransport({
    clientAbortSignal: clientAbort.signal,
    idleTimeoutMs: resolveStreamIdleTimeoutMs(resolvedName),
    rewriteShutdownAbort: true,
  })

  const driver = createPipelineDriver({
    codec,
    transport,
    hedgePolicy: createRuntimeHedgePolicy(resolvedName),
    candidateResponseSessionFactory: createAnthropicCandidateResponseSession,
    // S3 request-rewrites, S5 response-rewrites, and the S4 retry stack all come from the CellAssembly now
    // (C5 — every anthropic cell is migrated: the direct `/v1/messages` cell + the forward `@cc`/`@responses`
    // cells). `OUTBOUND_LEGS[/v1/messages]` supplies the sanitize chain (from env.requestState.preprocessInfo)
    // + the Anthropic strategy stack (from the codec-threaded truncateBaseline / resanitize / betaProbe).
    maxRetries: state.maxReactiveRetries,
    maxLearningRetries: MAX_LEARNING_RETRIES,
    // Post-gate meta sink (C0-② / RFC §11.2 + §12.4): rebuild the retry pipeline-info
    // from the accepted retry's meta (sanitization / strippedBetas / probedBetas) +
    // the codec's sampleRequest-captured effective body. Only fires after the budget
    // gate accepts the retry — a budget-rejected retry never emits phantom pipeline-info.
    onMeta: (meta, metaEnv) => {
      recordRetryPipelineStateV4({ meta, env: metaEnv, codec, preprocessInfo })
    },
  })

  // ③ (RFC §4.2.1): runRequest is fired OUTSIDE so it can race a grace timer. `p` runs the whole
  // S1–S4 pipeline (incl. the internal retry loop); the grace race only decides WHEN/WHETHER we open
  // the client stream early — it never re-issues the request.
  const p = driver.runRequest({
    body: wireBody,
    originalBodyForHistory: clientRaw,
    headers: c.req.raw.headers,
    method: c.req.method,
    path: c.req.path,
    query: resolveInboundQuery(c.req.url),
    preResolved: { name: resolvedName, model: args.selectedModel, ...(args.routeOverride && { routeOverride: args.routeOverride }) },
    clientAbortSignal: clientAbort.signal,
  })

  // The current (pre-③) path: await the upstream-settled runRequest, then dispatch. Shared by the ③
  // BYPASS (non-stream / grace disabled) AND the PRE-COMMIT branch (upstream returned/errored WITHIN
  // grace) — both keep the real HTTP status (zero divergence vs real Anthropic).
  const runUpstreamSettledPath = async (): Promise<Response> => {
    let result: DriverRequestResult
    try {
      result = await p
    } catch (error) {
      // Any failure after parse created the ctx (parse-period sanitize/translate throw, or an
      // exchange failure). Settle it — `codec.getContext()` reaches the ctx even when the throw
      // happened before the envelope was otherwise capturable.
      const ctx = codec.getContext()
      if (ctx) {
        c.set("requestContext", ctx)
        // A pre-response CLIENT disconnect is a cancellation, not a failure: record the distinct
        // `aborted` terminal state and return 499 rather than rethrowing into forwardError's
        // catch-all. Discriminate via our own clientAbort controller (here, pre-streamSSE, only the
        // client-disconnect bridge flips it) — NOT error.name (a response-header timeout does NOT
        // flip clientAbort, so it correctly falls through to fail → forwardError 504).
        if (error instanceof Error && isAbortError(error) && clientAbort.signal.aborted) {
          // 499 is a KNOWN literal decided HERE, before the abort snapshot — so capture it on the
          // clientResponse leg BEFORE ctx.abort() freezes the entry (mirrors the forward-boundary
          // status capture on the success paths). Distinct from the inherent settle-timing gap
          // where the forwarded status is only decided downstream (see docs/todo/deferred-backlog).
          ctx.setClientResponseStatus(499)
          ctx.abort(resolvedName)
          detachClientAbort()
          return c.body(null, 499 as ContentfulStatusCode)
        }
        ctx.fail(resolvedName, error)
      }
      detachClientAbort()
      throw error
    }

    // Expose the ctx so the observability middleware's safety net can finalize it from the HTTP
    // status if a path below doesn't settle it.
    const ctx = codec.getContext()
    if (ctx) c.set("requestContext", ctx)

    if (!result.ok) {
      // decideRoute reject (unsupported model) — shape the Anthropic 400. forwardError finishes the
      // response; the middleware finalizes the now-c.set ctx from the 4xx status (not a dangling entry).
      detachClientAbort()
      throw new HTTPError(result.rejection.reason, result.rejection.status, result.rejection.reason)
    }

    const { upstream, env } = result

    // D2 diagnostic: per-model effective frame-idle timeout (ctx live post-runRequest).
    env.ctx.setStreamTimeouts({ streamIdleTimeoutMs: resolveStreamIdleTimeoutMs(resolvedName) })

    if (!env.stream) {
      // Non-streaming: render the real HTTP status with the upstream-decided body.
      try {
        const resp = driver.runResponseNonStreaming(upstream, env) as AnthropicMessageResponse
        return renderNonStreamingV4(c, driver, env, resp, upstream.headers)
      } finally {
        detachClientAbort()
      }
    }

    // Streaming settled WITHIN the commit window: open 200 + pump on the same keepalive sink. The
    // upstream already returned ok, so this is the fast path (no pre-response stall); heartbeat still
    // covers mid-stream gaps. Real upstream errors were caught above → real HTTP status, never here.
    consola.debug("[Anthropic:v4] Streaming response (settled within window)")
    env.ctx.transition("streaming")
    // Upstream settled before the 200 opened → forward its headers onto the SSE response. Must
    // precede streamSSE so the headers are flushed with the response (and captured as inboundResponse).
    applyForwardedAnthropicResponseHeaders(c, upstream.headers)
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => clientAbort.abort())
      env.ctx.setInboundResponseHeaders(Object.fromEntries(c.res.headers.entries()))
      env.ctx.setClientResponseStatus(c.res.status)
      const { buffered, heartbeatSec } = resolveBufferedAndHeartbeat(env)
      const forwardedSseEvents: Array<SseEventRecord> = []
      const streamStartMs = Date.now()
      env.ctx.setClientTimingEpoch("streamOpen", streamStartMs) // 首包埋点（spec 2026-07-14 §3.2）
      // Synthetic-prelude keepalive: the sink's heartbeat carries the handler-owned UNIQUE injector (spec
      // §10.1.5 C1) + a shared AnchorState threaded to the pump → driver's buffered commit/close-off/remap.
      // `empty_text` → full anchor injector; `enveloped_ping` → envelope-only injector (message_start + bare
      // ping, no block/remap); `ping` → inert (undefined injector + hooks). Byte-equivalent on the live path
      // when no idle stall occurs (lazy — no injection).
      const { sink, anchorState, anchorHooks } = makeAnchoredSseSink(stream, {
        onForwarded: (record) => forwardedSseEvents.push(record),
        streamStartMs,
        heartbeatSec,
        clientAbortSignal: clientAbort.signal,
        resolvedName,
        reqId: codec.getContext()?.id ?? "unknown",
        ...clientFirstRealSinkOpts(env),
      })
      try {
        await pumpAnthropicStreamingDispatch({ sink, buffered, forwardedSseEvents, streamStartMs, driver, codec, upstream, env, anchorHooks, anchorState })
      } finally {
        sink.finalize?.() // terminal delivery drained; seals generation after any synthetic terminus
        detachClientAbort()
      }
    })
  }

  // Non-streaming: await the upstream-settled runRequest, then render the real HTTP status.
  if (!clientRaw.stream) {
    return runUpstreamSettledPath()
  }

  // === STREAMING: delayed-commit window. Wait up to streamCommitAfterSec for runRequest to settle
  // BEFORE opening the 200 SSE stream — an upstream return/error within the window keeps its real
  // HTTP status (the client retains native retry/backoff/token-refresh). Only when the window elapses
  // with the upstream still silent (opus pre-response thinking) do we COMMIT a 200 + connection-level
  // keepalive; later errors then degrade to a rich SSE error frame. 0 = commit immediately.
  //
  // The window is a DEADLINE measured from request ingress, not a timer started here. Nothing is
  // written to the client before the commit, so this window and the client's own pre-header limit
  // (~300s, undici's default headersTimeout — exp/silence-recovery-gates/FINDINGS.md) run on the same
  // clock — but the client's starts at ITS dispatch, while this handler is only reached after the
  // config/token middleware (`server.ts`), whose `ensureValidCopilotToken()` can spend real seconds
  // on retries with backoff. Timing the window from here would silently spend that time twice and
  // eat the margin the ceiling is supposed to guarantee.
  const ingressAtMs = c.get("ingressAtMs") as number | undefined
  const preHandlerElapsedMs = ingressAtMs === undefined ? 0 : Math.max(0, Date.now() - ingressAtMs)
  const remainingWindowMs = Math.max(0, state.streamCommitAfterSec * 1000 - preHandlerElapsedMs)
  if (state.streamCommitAfterSec > 0 && remainingWindowMs > 0) {
    let windowTimer: ReturnType<typeof setTimeout> | undefined
    const windowFired = new Promise<"window">((res) => {
      windowTimer = setTimeout(() => res("window"), remainingWindowMs)
      ;(windowTimer as unknown as { unref?: () => void }).unref?.()
    })
    // p.then consumes p's rejection so a window-win can't unhandledRejection (the commit body's
    // `await p` is the second reaction). Tie → upstream wins (microtask beats the macrotask timer).
    const first = await Promise.race([
      p.then(
        () => "upstream" as const,
        () => "upstream" as const,
      ),
      windowFired,
    ])
    clearTimeout(windowTimer)
    if (first === "upstream") return runUpstreamSettledPath() // settled within window → real HTTP status
  }

  // COMMIT: open 200 + start the connection-level keepalive, runRequest continues inside.
  // NOTE: upstream response headers CANNOT be forwarded here (strict_response_headers) — the 200
  // is flushed now, BEFORE the upstream settles (`await p` below), so its headers do not yet
  // exist. This is the documented forwarding limitation for delayed-commit streams; inboundResponse
  // faithfully records the (forward-less) headers actually sent.
  const commitCtx = codec.getContext()
  commitCtx?.recordFeature("stream-immediate-keepalive", {})
  if (commitCtx) {
    c.set("requestContext", commitCtx)
    commitCtx.transition("streaming")
  }
  const commitInstant = Date.now()
  return streamSSE(c, async (stream) => {
    // Cadence: streamKeepalivePingSec when set, else the protect-streaming heartbeat (buffered needs
    // a forced heartbeat; live tolerates it). 0 = both disabled. P2 lowers the default + clamps < 60.
    const pingSec = state.streamKeepalivePingSec > 0 ? state.streamKeepalivePingSec : resolveBufferedCaps("anthropic").heartbeatSec
    const forwardedSseEvents: Array<SseEventRecord> = []
    const streamStartMs = Date.now()
    commitCtx?.setClientTimingEpoch("streamOpen", commitInstant) // 首包埋点：延迟提交路径的 200 决定时刻
    // Synthetic-prelude keepalive (delayed-commit path). Built BEFORE the upstream settles — this is the
    // PURE pre-response window the incident hit: the sink's heartbeat carries the handler-owned UNIQUE
    // injector (spec §10.1.5 C1) which fires INDEPENDENTLY of the driver/pump (they don't run until
    // `await p` resolves), synthesizing a message_start prelude when the upstream is silent (no captured
    // message_start) — a full empty-text anchor (`empty_text`) or a message_start-only envelope
    // (`enveloped_ping`). The shared AnchorState + hooks flow to the pump below. Inert for `ping`.
    const { sink, anchorState, anchorHooks } = makeAnchoredSseSink(stream, {
      onForwarded: (record) => forwardedSseEvents.push(record),
      streamStartMs,
      heartbeatSec: pingSec,
      clientAbortSignal: clientAbort.signal,
      resolvedName,
      reqId: codec.getContext()?.id ?? "unknown",
      // 首包埋点：/v1/messages 客户端格式恒 "anthropic"（延迟提交路径无 env 变量在 scope）。
      ...(commitCtx && clientFirstRealSinkOpts({ clientFormat: "anthropic", ctx: commitCtx })),
    })
    stream.onAbort(() => clientAbort.abort()) // register BEFORE the first ping (round-B L1)
    // ④ capture proxy→client headers (set synchronously by streamSSE before this callback).
    commitCtx?.setInboundResponseHeaders(Object.fromEntries(c.res.headers.entries()))
    commitCtx?.setClientResponseStatus(c.res.status)
    // empty_text anchor terminal close-off (spec §10.5 / §3.4). When the pre-response injector lit a
    // synthetic empty-text anchor block during the stall (§10.1.5 C1) and the request THEN fails
    // POST-COMMIT, the client is otherwise left with an OPEN content_block@0 — a protocol-incomplete
    // stream. Every branch below that writes an `event: error` frame first closes the anchor off via the
    // SHARED {@link closeAnchorIfOpen} primitive (stop@0, synthetic:"anchor") so the block structure stays
    // balanced. The SAME primitive collapses the pre-pump (here) + pump terminal (pumpAnthropicStreamingV4)
    // + live-reconcile + driver-buffered close-off sites onto one `anchorState.anchorClosed` guard — the
    // anchor is closed exactly once no matter which terminus fires first (idempotent; inert when no anchor
    // was injected → byte-equivalent to the no-anchor path).
    try {
      // Immediate first ping on a COLD-START commit (the upstream stalled past the whole window → known
      // slow). It (a) establishes the body stream NOW so a fast upstream failure right after commit is
      // forwarded immediately instead of after a full cadence, (b) anchors CC's body-idle on a real body
      // frame without relying on "200 headers reset idle", (c) maxes the idle margin. The heartbeat's
      // cadence then throttles every later ping (lastRealMs advances) → exactly ONE extra frame. Gated:
      // only when we actually waited a window (commitAfterSec>0; the 0 immediate-bypass keeps the
      // byte-identical path) AND keepalive is on (pingSec>0). best-effort write.
      if (state.streamCommitAfterSec > 0 && pingSec > 0) await (sink.writeKeepalive ?? sink.write)(ANTHROPIC_PING).catch(() => {})
      // POST-COMMIT: every exit settles ctx + (on failure) writes a rich error frame — the SSE
      // middleware does NOT finalize an event-stream, so a silent return would leak a dangling entry.
      // Unit 1 (reduced) reorder: close anchor → writeSynthetic → setForwardedResponse → fail, so the
      // TRANSIENT `request.failed` snapshot (toHistoryEntry reads `_forwardedResponse`) also includes the
      // client-received error frame + anchor stop@0 (the durable V3 projection already captured them via
      // the generation recorder). `finally` guarantees settle even if closeAnchor/writeSynthetic REJECT —
      // a write reject must never skip fail (that would leak an unsettled request, worse than an
      // incomplete snapshot). The terminal frame is already sampled into `forwardedSseEvents` at
      // write-attempt time ("recorded == attempted-to-send"), so the snapshot is complete regardless.
      const writeTerminalThenSettle = async (ctx: ReturnType<typeof codec.getContext>, frame: ClientFrame | undefined, settle: () => void): Promise<void> => {
        try {
          await closeAnchorIfOpen(sink, anchorHooks, anchorState) // balance an open pre-response anchor before the error terminus (§10.5)
          if (frame) await sink.writeSynthetic?.(frame)
        } catch {
          // best-effort terminal write — fall through to snapshot + settle
        } finally {
          ctx?.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })
          settle()
        }
      }
      let result: DriverRequestResult
      try {
        result = await p
      } catch (error) {
        const ctx = codec.getContext()
        // Snapshot what the client received BEFORE settling (ctx.fail/abort finalizes the entry
        // synchronously) — the first ping (+ heartbeat pings during the stall) are genuinely on the
        // wire, so a POST-COMMIT FAILURE entry must record them too (richest-data-flow, mirrors the
        // pump's recordForwarded ordering).
        ctx?.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })
        if (error instanceof Error && isAbortError(error)) {
          // Discriminate by the abort's OWN provenance (§4.2.1), with signal state as the fallback:
          // shutdown / header-watchdog / hard-deadline / reaper / dispatch teardown each carry their
          // own identity now, so the terminal frame names the real cause instead of defaulting to
          // "reaper or timeout, pick one".
          const kind = classifyPostCommitAbort(clientAbort.signal.aborted, ctx?.lifecycleSignal, error)
          // An `unknown-abort` reaching a client is a WIRING GAP (some producer aborted without a
          // cause tag), not a normal outcome — count it so it shows up on /metrics rather than only
          // inside one History entry. See `~/lib/observability/abort-provenance-gaps`.
          if (kind === "unknown-abort") recordAbortProvenanceGap("delayed-commit", "anthropic")
          if (kind === "client-abort") {
            ctx?.abort(resolvedName) // (e) client gone — zero further bytes, no 499 (already 200)
            return
          }
          // (f) reaper-cancel (reaper already settled it; the `settled` guard dedups) / (d) every other
          // cause. reaper-cancel's fail is a no-op (reaper pre-settled) so the reorder does NOT complete
          // its transient snapshot — that needs a two-phase reaper protocol (spec §1.3, backlog). The
          // handler-settled kinds ARE completed by the reorder.
          await writeTerminalThenSettle(ctx, postCommitAbortFrame(kind), () => ctx?.fail(resolvedName, error))
          return
        }
        if (error instanceof HTTPError) {
          // (c) upstream 4xx/5xx — the dominant POST-COMMIT divergence. The rich frame preserves
          // error.type (+ retry_after) so the client SDK still branches correctly (Q2 §4.2.5).
          // G-3: delegated to the error-shaping builder (canonical ownership); disabled = the legacy
          // anthropicHttpErrorFrame verbatim (CF-2 golden lock).
          await writeTerminalThenSettle(ctx, shapePostcommitErrorFrame(error, anthropicHttpErrorFrame(error), ctx), () => ctx?.fail(resolvedName, error))
          return
        }
        // (①' G-3, MEDIUM-1) classifyError maps this branch's errors (socket reset / HTTP2
        // REFUSED_STREAM / other non-HTTPError) to network_error / bad_request → decide() → canonical.
        // This is the ONLY path that produces post-commit network_error, so the Phase 1 truth table's
        // network_error→canonical-error promise is exercised here. Disabled = the legacy api_error frame
        // verbatim (CF-2 golden lock).
        await writeTerminalThenSettle(
          ctx,
          shapePostcommitErrorFrame(error, anthropicErrorFrame("api_error", error instanceof Error ? error.message : String(error)), ctx),
          () => ctx?.fail(resolvedName, error), // unknown non-HTTP, non-abort
        )
        return
      }
      if (!result.ok) {
        // (b) decideRoute reject — RESOLVE not throw (C2), the try/catch above can't catch it.
        const ctx = codec.getContext()
        await writeTerminalThenSettle(ctx, anthropicRejectErrorFrame(result.rejection.status, result.rejection.reason), () =>
          ctx?.fail(resolvedName, new HTTPError(result.rejection.reason, result.rejection.status, result.rejection.reason)),
        )
        return
      }
      // (a) ok → hand the SAME sink to the pump (single-sink, no rebuild). The commit ping cadence
      // baked into the sink continues as the post-commit keepalive during generation.
      const { upstream, env } = result
      // D2 diagnostic (POST-COMMIT branch): per-model effective frame-idle timeout.
      env.ctx.setStreamTimeouts({ streamIdleTimeoutMs: resolveStreamIdleTimeoutMs(resolvedName) })
      const { buffered } = resolveBufferedAndHeartbeat(env)
      commitCtx?.recordFeature("stream-upstream-resolved", { totalStalledMs: Date.now() - commitInstant })
      await pumpAnthropicStreamingDispatch({ sink, buffered, forwardedSseEvents, streamStartMs, driver, codec, upstream, env, anchorHooks, anchorState })
    } finally {
      sink.finalize?.()
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
 *     pre-initial-sanitize); mapping effective ← `ctx.currentAttempt?.effectiveRequest?.messages`
 *     (the per-attempt sample the anthropic-cell captured; the `action.env.body === action.payload`
 *     invariant makes it the retry's body). (The `thinking` feature is NOT rebuilt here — it
 *     is emitted per-attempt by the leg's wire prep as a terminal `{requested, effective}`
 *     dimension; see anthropic-leg.ts / observability console sink.)
 *   - sanitization / strippedBetas / probedBetas ← `meta` (onMeta, post-gate).
 */
function recordRetryPipelineStateV4(args: RecordRetryPipelineStateV4Args): void {
  const { meta, codec, preprocessInfo, env } = args
  const ctx = codec.getContext()
  if (!ctx) return

  // Data sources re-homed from the codec closure to env.requestState + ctx (RFC §11.2 / C2a): the
  // direct `/v1/messages` cell is now dispatched through the CellAssembly (stateless), so the codec's
  // prepareWire/sampleRequest closure is no longer written — the leg supply lives on env.requestState and
  // the per-attempt side-channels on ctx.currentAttempt. The message-mapping / stripped-cache-control are
  // DIRECT-leg concerns only (a forward @cc/@responses leg's ctx attempt is CC-shaped), so gate them on
  // the direct target exactly as the codec's `!isForwardTranslateLeg` branch did.
  const isDirect = env.targetEndpoint === ENDPOINT.MESSAGES
  const baseline = env.requestState?.truncateBaseline as MessagesPayload | undefined
  const effectiveMessages = isDirect ? ctx.currentAttempt?.effectiveRequest?.messages : undefined

  const initialSanitizationInfo = ctx.initialSanitizationInfo
  const retrySanitization = meta.sanitization as SanitizationStats | undefined
  const allSanitization = [...(initialSanitizationInfo ? [initialSanitizationInfo] : []), ...(retrySanitization ? [toSanitizationInfo(retrySanitization)] : [])]

  const retryMessageMapping =
    baseline && effectiveMessages ? buildMessageMapping(baseline.messages, effectiveMessages as MessagesPayload["messages"]) : undefined

  const strippedCacheControl = isDirect ? ctx.currentAttempt?.cacheControlStripped : undefined
  ctx.setPipelineInfo({
    preprocessing: preprocessInfo,
    sanitization: allSanitization,
    ...(retryMessageMapping && { messageMapping: retryMessageMapping }),
    ...(strippedCacheControl?.length && { cacheControlStripped: [...strippedCacheControl] }),
  })

  // Sticky feature tag for the accepted retry. Beta-strip is NOT exhaustive — many
  // strategies (server-tool / structured-outputs / body-field / deferred-tool /
  // legacy-thinking / network / token-refresh) emit meta with no signal, and must
  // NOT be branded with a feature.
  const retryFeature = retryMetaFeature(meta)
  if (retryFeature) ctx.recordFeature(retryFeature.feature, retryFeature.detail)
}

// ============================================================================
// Upstream response-header forwarding
// ============================================================================

/**
 * Forward a controlled subset of the upstream (GHC) response headers onto the client
 * response, gated by `anthropic.strict_response_headers` (see `lib/anthropic/header-policy/response-header-forward.ts`).
 *
 * MUST be called BEFORE the response is constructed (`streamSSE` / `c.json`): `c.header()`
 * seeds Hono's prepared-header map, so a call afterwards would not reach `c.res` (and the
 * `setInboundResponseHeaders` capture would miss it). The proxy-controlled blacklist (content
 * framing + hop-by-hop) is always dropped, so a forwarded header can never clobber the headers
 * `streamSSE` / `c.json` set themselves.
 *
 * Only callable on the NON-committed write-out paths (non-streaming + streaming settled within
 * the commit window). A delayed-commit stream has already flushed its 200 before the upstream
 * headers exist, so it forwards nothing — `inboundResponse` then faithfully records that.
 */
function applyForwardedAnthropicResponseHeaders(c: Context, upstreamHeaders: Headers): void {
  const forward = selectForwardableResponseHeaders(upstreamHeaders, {
    strict: state.strictResponseHeaders,
    blacklist: state.responseHeaderBlacklist,
    whitelist: state.responseHeaderWhitelist,
  })
  // `upstreamHeaders` is a validated `Headers` (the transport builds it via `new Headers(...)`),
  // so every value already passed WHATWG validation — `c.header()` re-set cannot throw on it
  // (a CR/LF/NUL value would have been rejected upstream, never reaching here). No guard needed.
  for (const [name, value] of Object.entries(forward)) c.header(name, value)
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
/** Feature tag per wire disposition — exhaustive Record so a new mode cannot be silently untagged. */
const REFUSAL_FEATURE_BY_MODE: Record<RefusalMode, FeatureKind> = {
  refusal: "refusal-passthrough",
  end_turn: "refusal-recovered",
  error: "refusal-errored",
}

function renderNonStreamingV4(
  c: Context,
  driver: ReturnType<typeof createPipelineDriver>,
  env: RequestEnvelope,
  response: AnthropicMessageResponse,
  upstreamHeaders: Headers,
): Response {
  const reqCtx = env.ctx
  let finalResponse = response

  finalResponse = driver.runResponseWhole(finalResponse, env) as AnthropicMessageResponse

  // Flush tool-input repair outcomes (telemetry + feature tag + log). Non-streaming is single-attempt,
  // so this records once; the unrepairable fail-gate below reads the derived `unrepairableToolInput`.
  flushToolInputRepairObservability(reqCtx)

  // Contentless refusal, non-streaming. The disposition was applied by the S5 `transformWhole`
  // (suppression rewrote the body; `error`/`refusal` left it untouched) and REPORTED on the ctx —
  // read that report rather than re-deriving from the hot-reloadable `state` (see the streaming
  // branch for why). Only `error` mode changes the HTTP shape (a 500 error body instead of the 200);
  // suppression/passthrough keep the 200 and merely settle FAILED via the shared fail-gate below.
  // Mirrors the truncation fail-gate's header/inbound timing (c.json builds headers ->
  // setInboundResponseHeaders -> fail; never `throw` -- that would skip c.json and drop the
  // inboundResponse leg, see memory hono-onerror-consumes-throws).
  const isRefusal = response.stop_reason === "refusal" && !hasClientVisibleContent(response.content as unknown as Array<{ type: string }>)
  const refusalMode = reqCtx.refusalPolicy.mode
  if (isRefusal)
    reqCtx.recordFeature(REFUSAL_FEATURE_BY_MODE[refusalMode], {
      category: refusalCategoryForDiagnostics((response as { stop_details?: unknown }).stop_details),
    })
  if (isRefusal && refusalMode === "error") {
    const summary = refusalSummary(extractRefusalDetail((response as { stop_details?: unknown }).stop_details))
    // Emission point 4 (non-streaming error body). Templates come from the FROZEN policy, not from
    // the live `state`: the disposition was decided at transformWhole time, and any concurrent
    // request carrying a `system` re-runs applyConfigToState() (handler-v4.ts:384) in between — so
    // reading `state` here could render this response's body from a different config than the one
    // that chose to render it at all. The empty-type fallback is already resolved in the snapshot.
    const policy = reqCtx.refusalPolicy
    const errVars = refusalVarsFromResponse(response, { model: response.model, request_id: reqCtx.id })
    const errorBody = { type: "error", error: { type: policy.errorType, message: renderRefusalTemplate(policy.errorMessage, errVars) } }
    // The client receives the 500 error BODY (not the upstream content) — record THAT as the
    // forwarded (proxy→client) response so inboundResponse faithfully mirrors what the client got
    // (the upstream-original thinking blocks are preserved on outboundResponse via fail's partial).
    reqCtx.setForwardedResponse({ content: errorBody })
    applyForwardedAnthropicResponseHeaders(c, upstreamHeaders)
    const errResponse = c.json(errorBody, 500)
    reqCtx.setInboundResponseHeaders(Object.fromEntries(errResponse.headers.entries()))
    reqCtx.setClientResponseStatus(errResponse.status)
    consola.error(`[REFUSAL] ${summary} for ${response.model} -> wire=error (non-streaming), recorded as failed`)
    // Upstream leg SUCCEEDED (delivered a complete refusal response); the proxy introduced the error
    // verdict → upstreamSucceeded keeps outboundResponse honest + routes the verdict to failureReason.
    reqCtx.fail(
      response.model,
      new Error(summary),
      {
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined,
          cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? undefined,
        },
        stop_reason: response.stop_reason ?? undefined,
        stopDetails: (response as { stop_details?: unknown }).stop_details,
        content: { role: "assistant", content: response.content },
        sourceBody: response,
      },
      { upstreamSucceeded: true },
    )
    reqCtx.finalizeModelOperationDelivery({ clientPayload: errorBody })
    return errResponse
  }

  reqCtx.setForwardedResponse({ content: finalResponse })
  // Forward the controlled subset of upstream response headers BEFORE c.json builds the
  // response, so they land in clientResponse.headers (and the inboundResponse capture below).
  applyForwardedAnthropicResponseHeaders(c, upstreamHeaders)
  // RFC Phase 4: ④ build the client response first so its headers are set, capture them
  // (proxy→client), THEN complete — finalize must see the inboundResponse leg.
  const clientResponse = c.json(finalResponse)
  reqCtx.setInboundResponseHeaders(Object.fromEntries(clientResponse.headers.entries()))
  reqCtx.setClientResponseStatus(clientResponse.status)

  // Non-streaming semantic-truncation gate: a 200 without stop_reason is a
  // semantically truncated response — record fail() (not silent complete) while
  // still forwarding the upstream body + preserving the partial (richest-data-flow).
  const truncationReason = anthropicNonStreamingTruncation(response.stop_reason)
  // An unrepairable malformed tool_use input (P5, mirrors the streaming fail-gate): the body is
  // still forwarded (richest-data-flow), but the request is recorded FAILED, not a silent success.
  // Takes priority over truncation — a more precise root cause. The flag is set by the decode S5
  // transformWhole's onDecodeFailure closure during runResponseWhole above.
  const unrepairableTool = reqCtx.unrepairableToolInput
  // A suppressed / passed-through contentless refusal still settles FAILED: the client received a
  // clean turn as a PRESENTATION policy, which is not a claim that the turn produced anything.
  const refusalReason = isRefusal ? refusalSummary(extractRefusalDetail((response as { stop_details?: unknown }).stop_details)) : null
  const failReason = refusalReason ?? (unrepairableTool !== null ? `unrepairable malformed tool_use input (tool=${unrepairableTool})` : truncationReason)
  const responseData = {
    success: !failReason,
    model: response.model,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? undefined,
    },
    stop_reason: response.stop_reason ?? undefined,
    stopDetails: (response as { stop_details?: unknown }).stop_details,
    content: { role: "assistant", content: response.content },
    sourceBody: response,
    responseText: JSON.stringify(response),
  }
  if (failReason) {
    // Unrepairable = upstream delivered a COMPLETE 200 body that the proxy rejected → upstreamSucceeded
    // keeps outboundResponse honest + routes the verdict to failureReason. Semantic truncation = an
    // INCOMPLETE upstream body (genuine upstream failure) → stays success:false.
    reqCtx.fail(
      response.model,
      new Error(failReason),
      {
        usage: responseData.usage,
        stop_reason: responseData.stop_reason,
        stopDetails: responseData.stopDetails,
        content: responseData.content,
        sourceBody: response,
      },
      // Refusal + unrepairable = a COMPLETE 200 upstream body the proxy re-judged → upstreamSucceeded
      // keeps outboundResponse honest. Semantic truncation = an INCOMPLETE body → stays success:false.
      refusalReason !== null || unrepairableTool !== null ? { upstreamSucceeded: true } : undefined,
    )
  } else {
    reqCtx.complete(responseData)
  }

  // Diagnostic receipt: upstream reports its applied context edits at top-level context_management.
  // Record only when it actually cleared something — the authoritative signal that our injected
  // context_management did anything.
  const ctxEdits = summarizeAppliedEdits(extractAppliedEdits((response as { context_management?: unknown }).context_management))
  if (ctxEdits.count > 0) {
    reqCtx.recordFeature("context-edits-applied", { count: ctxEdits.count, clearedInputTokens: ctxEdits.clearedInputTokens, types: ctxEdits.types })
  }

  reqCtx.finalizeModelOperationDelivery({ clientPayload: finalResponse })
  return clientResponse
}

// ============================================================================
// Streaming pump (byte-critical primitives reused from streaming-pump.ts)
// ============================================================================

// ANTHROPIC_PING + makeAnthropicKeepaliveFrame + resolveAnthropicKeepalive live in
// ~/lib/anthropic/keepalive-frame (shared with the web_search bypass heartbeat in streaming-pump.ts).

/**
 * Build the format-specific {@link AnchorHooks} the Anthropic empty-text keepalive anchor needs — the
 * synthetic frames (anchor start/stop/delta + the fabricated message_start), the message_start predicate,
 * and the +1 index remap (spec 2026-07-08-buffered-keepalive-empty-text-anchor §3.2 / §10.1.5, layering H2).
 *
 * The driver only ORCHESTRATES the buffered commit side (freeze + close-off + remap + dedup, reading the
 * SHARED {@link AnchorState}); the actual injection is driven by the handler's UNIQUE injector
 * ({@link makeSyntheticAnchorInjector} for empty_text / {@link makeSyntheticEnvelopeInjector} for
 * enveloped_ping) attached to the sink's `heartbeat.injectAnchor` — so it fires in the pre-response
 * `await p` window, independently of the driver/pump (spec §10.1.5 C1). Built for BOTH synthetic-prelude
 * modes (`empty_text` + `enveloped_ping`); `ping` returns undefined so every anchor branch stays inert
 * (byte-identical to before). The enveloped_ping hooks carry the (unused) anchor start/stop/delta frames too
 * — the AnchorHooks shape is uniform; the injector + `anchorBlockOpen` state, not the hooks, decide whether
 * an anchor block is actually opened. No `bindInjector` holder anymore — the handler owns both the injector
 * construction and the sink, wiring them via a `sinkRef` self-reference at the call sites.
 */
function buildAnthropicAnchorHooks(enabled: boolean): AnchorHooks | undefined {
  if (!enabled) return undefined
  return {
    isMessageStart: (f) => {
      if (typeof f.data !== "string") return false
      try {
        return (JSON.parse(f.data) as { type?: unknown }).type === "message_start"
      } catch {
        return false // non-JSON frame (e.g. a keepalive line) — not message_start
      }
    },
    isContentBlockStart: isAnthropicContentBlockStart,
    startFrame: anchorStartFrame,
    stopFrame: anchorStopFrame,
    deltaFrame: anchorDeltaFrame,
    syntheticMessageStart: (model, reqId) => syntheticMessageStartFrame(model, reqId),
    remap: remapAnthropicBlockIndex,
  }
}

/**
 * Construct an SSE sink whose heartbeat carries the handler-owned UNIQUE synthetic keepalive injector
 * (empty_text mode — spec §10.1.5 C1), returning the SHARED {@link AnchorState} + hooks the caller
 * threads into the pump → driver's buffered commit/close-off/remap.
 *
 * The load-bearing detail: the injector must read its sink at CALL time (an idle heartbeat tick), but the
 * sink's construction options are evaluated BEFORE the sink object exists — so the injector closes over a
 * `let sinkRef` holder assigned right after construction (spec §10.1.5 H1). This one function owns that
 * self-reference dance so the two call sites (settled-within-window + delayed-commit) can't diverge. When
 * `stream_keepalive_mode` is not `empty_text` the injector + hooks are undefined and the heartbeat is a
 * plain ping (byte-identical to before); `heartbeatSec <= 0` omits the heartbeat entirely.
 */
function makeAnchoredSseSink(
  stream: Parameters<typeof makeDeliverySseSink>[0],
  args: {
    onForwarded: (record: SseEventRecord) => void
    streamStartMs: number
    heartbeatSec: number
    clientAbortSignal: AbortSignal
    resolvedName: string
    reqId: string
    // 首包埋点（spec 2026-07-14 §3.2）：客户端首个真实内容帧 → ctx firstReal（透传给 makeSseSink）。
    isRealContentFrame?: (frame: ClientFrame) => boolean
    onFirstRealContent?: () => void
    onGenerationFrame?: (frame: ClientFrame, record: SseEventRecord, syntheticKind?: SseEventRecord["synthetic"]) => void
    onDeliveryFinalized?: () => void
  },
): { sink: ClientSink; anchorState: AnchorState; anchorHooks: AnchorHooks | undefined } {
  const {
    onForwarded,
    streamStartMs,
    heartbeatSec,
    clientAbortSignal,
    resolvedName,
    reqId,
    isRealContentFrame,
    onFirstRealContent,
    onGenerationFrame,
    onDeliveryFinalized,
  } = args
  // The normal configured mode may stay `ping`, but on-demand escalation still needs the same
  // anchor hooks when a pre-content silence approaches Claude Code's 300s event-idle deadline.
  const onDemandEscalation = state.streamKeepaliveEscalateSec > 0
  const anchorHooks = buildAnthropicAnchorHooks(state.streamKeepaliveMode !== "ping" || onDemandEscalation)
  // One shared wire state, with separate envelope/content latches. The normal enveloped_ping
  // prelude sets `injected`; the content injector gates on `contentAnchorInjected` instead.
  const allocator = createGenerationWireIndexAllocator()
  const wireState = createGenerationWireState(allocator)
  const anchorState: AnchorState = {
    wireState,
    injected: false,
    contentAnchorInjected: false,
    messageStartForwarded: false,
    anchorBlockOpen: false,
    anchorClosed: false,
  }
  // Late-bind holder: the injector must read its sink at CALL time (an idle tick), but the sink's options
  // are evaluated before the sink exists — so `getSink` reads this holder, assigned right after construction.
  const sinkHolder: { current: ClientSink | undefined } = { current: undefined }
  // `empty_text` → full anchor injector (message_start + anchor block@0 + empty delta, anchorBlockOpen=true);
  // `enveloped_ping` → envelope-only injector (message_start ONLY, anchorBlockOpen stays false → bare ping
  // after, no block, no remap — spec §10.6).
  const makeInjector = state.streamKeepaliveMode === "enveloped_ping" ? makeSyntheticEnvelopeInjector : makeSyntheticAnchorInjector
  const injectAnchor =
    anchorHooks && state.streamKeepaliveMode !== "ping" ?
      makeInjector({ anchor: anchorHooks, state: anchorState, getSink: () => sinkHolder.current, resolvedName, reqId })
    : undefined
  const injectContentAnchor =
    anchorHooks && onDemandEscalation ?
      makeSyntheticAnchorInjector({
        anchor: anchorHooks,
        state: anchorState,
        getSink: () => sinkHolder.current,
        resolvedName,
        reqId,
        independentContentLatch: state.streamKeepaliveMode === "enveloped_ping",
      })
    : undefined
  const sink = makeDeliverySseSink(stream, {
    wireState,
    onForwarded,
    streamStartMs,
    ...(isRealContentFrame && { isRealContentFrame }),
    ...(onFirstRealContent && { onFirstRealContent }),
    ...(onGenerationFrame && { onGenerationFrame }),
    ...(onDeliveryFinalized && { onDeliveryFinalized }),
    ...(heartbeatSec > 0 && {
      heartbeat: {
        intervalSec: heartbeatSec,
        pingFrame: resolveAnthropicKeepalive(state.streamKeepaliveMode),
        clientAbortSignal,
        ...(injectAnchor && { injectAnchor }),
        ...(onDemandEscalation && {
          contentDeadlineSec: state.streamKeepaliveEscalateSec,
          contentFrame: makeAnthropicKeepaliveFrame,
          ...(injectContentAnchor && { injectContentAnchor }),
        }),
      },
    }),
  })
  sinkHolder.current = sink
  return { sink, anchorState, anchorHooks }
}

/**
 * Resolve the buffered-retry routing flag + the live heartbeat cadence for an Anthropic
 * streaming request. Single source for both (DRY) — the caller builds the sink (heartbeat)
 * and routes the pump (buffered) from one call.
 *
 * - `buffered` (L2, RFC §9): `"on"` buffers every stream; `"tool_use_only"` buffers only
 *   when the request carries `tools`.
 * - `heartbeatSec`: the buffered path withholds ALL real frames until message_stop, so it
 *   FORCES a heartbeat (`streamKeepalivePingSec` when set, else
 *   `resolveBufferedCaps("anthropic").heartbeatSec` fallback). The live path heartbeats only
 *   when the operator set `streamKeepalivePingSec`.
 */
function resolveBufferedAndHeartbeat(env: RequestEnvelope): { buffered: boolean; heartbeatSec: number } {
  const anthropicPayload = env.body as MessagesPayload
  const buffered =
    state.protectStreamingGeneration === "on"
    || (state.protectStreamingGeneration === "tool_use_only" && Array.isArray(anthropicPayload.tools) && anthropicPayload.tools.length > 0)
  const forcedHeartbeatSec = state.streamKeepalivePingSec > 0 ? state.streamKeepalivePingSec : resolveBufferedCaps("anthropic").heartbeatSec
  const heartbeatSec = buffered ? forcedHeartbeatSec : state.streamKeepalivePingSec
  return { buffered, heartbeatSec }
}

interface PumpAnthropicStreamingV4Options {
  /** The driver-owned client sink (SSE write-out + forwarded sampling + heartbeat). Built by
   *  the caller so the ③ commit path can emit a first ping on the SAME sink (RFC §4.2.1 C1). */
  sink: ClientSink
  /** L2 buffered-retry routing — resolved by the caller via {@link resolveBufferedAndHeartbeat}. */
  buffered: boolean
  /** The caller-owned forwarded-track array the sink samples into; the pump snapshots it onto ctx. */
  forwardedSseEvents: Array<SseEventRecord>
  /** Stream-start instant (ms) — threaded from the caller so the sink's forwarded `offsetMs`
   *  and the pump's completion summary share one origin (byte-equivalence). */
  streamStartMs: number
  driver: ReturnType<typeof createPipelineDriver>
  upstream: UpstreamStream
  env: RequestEnvelope
  /**
   * Synthetic-prelude keepalive anchor hooks (spec 2026-07-08-buffered-keepalive-empty-text-anchor).
   * Present on both synthetic-prelude modes (`empty_text` + `enveloped_ping`); passed straight into
   * `runResponseBufferedSink` as `opts.anchor` (the live `runResponseSink` branch wraps the sink via
   * {@link liveReconcilingSink} instead). The driver's buffered commit reads `anchorState.anchorBlockOpen`
   * to decide whether to remap (`empty_text`) or only dedup the message_start (`enveloped_ping`). Undefined
   * for `ping` → the driver's anchor orchestration is inert (byte-identical to before).
   */
  anchorHooks?: AnchorHooks
  /**
   * The handler-owned SHARED {@link AnchorState} (spec §10.1.5 H1). The handler's unique injector
   * (attached to the sink's `heartbeat.injectAnchor`) and the driver's buffered commit/close-off/remap
   * both read/write THIS instance, so `injected`/`messageStartForwarded`/`anchorBlockOpen`/
   * `capturedMessageStart` are one source of truth. Threaded into `runResponseBufferedSink` as
   * `opts.anchorState`. Undefined for `ping` (the driver then self-creates an inert local).
   */
  anchorState?: AnchorState
}

/** {@link pumpAnthropicStreamingDispatch} options — the pump options plus the codec (for the translate leg). */
interface PumpAnthropicStreamingDispatchOptions extends PumpAnthropicStreamingV4Options {
  /** The per-request anthropic codec — the translate leg reads its `getStreamMeta` / `flushResponse`. */
  codec: ReturnType<typeof createAnthropicCodec>
}

/**
 * Dispatch the streaming pump by OUTBOUND leg (RFC §3.1 二维门控). The DIRECT `/v1/messages` leg (upstream
 * IS Anthropic — render is identity) drives the byte-critical {@link pumpAnthropicStreamingV4}, UNCHANGED.
 * A FORWARD translate leg (`@cc`/`@responses` — upstream is CC/Responses, render TRANSLATES per-frame to
 * Anthropic) drives {@link pumpTranslateLegStreamingV4}, which reuses the SAME anchored keepalive sink +
 * reconcile (the client is still Claude Code — the 300s no-real-content deadline applies to the translated
 * Anthropic stream, so it must NOT mirror gemini's no-heartbeat path) but settles from the codec's
 * translator meta instead of an Anthropic accumulator.
 */
async function pumpAnthropicStreamingDispatch(opts: PumpAnthropicStreamingDispatchOptions): Promise<void> {
  const targetEndpoint = opts.env.targetEndpoint
  if (targetEndpoint === ENDPOINT.CHAT_COMPLETIONS || targetEndpoint === ENDPOINT.RESPONSES || targetEndpoint === ENDPOINT.WS_RESPONSES) {
    return pumpTranslateLegStreamingV4(opts)
  }
  return pumpAnthropicStreamingV4(opts)
}
/**
 * Wrap the live pump's sink in the §10.3 reconciliation (drop the real message_start; for `empty_text` also
 * close the anchor off before the first real content_block_start + remap real blocks +1; for `enveloped_ping`
 * pass real blocks through at their original index) — but ONLY the LIVE path (§10.1.5 C2). The buffered path
 * does its remap INSIDE the driver (commit flush), so decorating there would double-apply the non-idempotent
 * index+offset; this helper is therefore called EXCLUSIVELY on the `runResponseSink` (live) branch. Returns
 * the RAW sink unchanged when the anchor is inert (no hooks / no shared state — `ping`), keeping the live path
 * byte-equivalent. The transform itself branches on `anchorState.anchorBlockOpen` (§10.6).
 */
function liveReconcilingSink(sink: ClientSink, anchorHooks: AnchorHooks | undefined, anchorState: AnchorState | undefined): ClientSink {
  return anchorHooks && anchorState ? makeReconcilingSink(sink, anchorState, anchorHooks) : sink
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
  const { sink, buffered, forwardedSseEvents, driver, upstream, env, anchorHooks, anchorState } = opts
  const anthropicPayload = env.body as MessagesPayload
  const model = anthropicPayload.model

  // Snapshot the forwarded track onto the ctx (R3-④: forwardedSseEvents is aliased by
  // entry.inboundResponse — `close()` in runResponseSink's finally already stopped the
  // heartbeat, but a fresh copy is the durable guard against a late ping mutating it).
  const recordForwarded = (): void => env.ctx.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })

  // The driver drives the S5 chain + writes the rewritten frames to the sink; `[DONE]` is
  // dropped inside runResponseSink (Anthropic emits no trailing terminator). The outcome
  // is the format-agnostic control signal; the handler reads its own `acc` for the rest.
  //
  // L2 buffered path: the driver buffers the whole rendered response and commits to the sink
  // ONLY on `drained && sawMessageStop()` (a clean RST drains cleanly but lacks message_stop →
  // truncation → retry). `onAttemptReset` rebinds the four upstream-side accumulators before
  // each re-exchange so a fresh generation never double-counts the previous attempt; the driver
  // re-instantiates its own S5 chain state per attempt. `forwardedSseEvents` is intentionally
  // NOT reset (heartbeat pings already on the client wire stay recorded — RFC §10 correction).

  // The await is INSIDE the try so a throw from the driver/sink still records forwarded + settles the
  // entry (catch) — no dangling entry, no lost keepalive track. finally re-guards. The driver returns
  // a ResponseOutcome on the handled paths; only an unexpected throw reaches catch.
  try {
    const outcome =
      buffered ?
        await driver.runResponseBufferedSink(upstream, env, sink, {
          // Buffered synthetic-prelude keepalive (spec 2026-07-08 / §10.6): the handler's injector lazily
          // forwards a message_start prelude via the sink's heartbeat.injectAnchor during a pre-commit stall.
          // On commit the driver dedups the buffered message_start and — for `empty_text` (anchorBlockOpen) —
          // closes the anchor off + remaps real blocks +1; for `enveloped_ping` (no block) it only dedups.
          // Undefined for `ping` → every anchor branch in the driver is inert.
          anchor: anchorHooks,
          anchorState,
          // Anthropic block-level commit remains a handler-selected delivery policy. The
          // candidate session owns accumulators/diagnostics but must not shadow this outer gate.
          commitBoundaries: anthropicCommitBoundaries,
          // Continuation-retry (spec 2026-07-22 §4-§5, ADR D3): after a committed block, a mid-stream cut
          // runs a synthetic continuation exchange whose frames stitch onto the same client stream. The
          // ledger accumulates the delivered prefix (extractor → text/tool_use, thinking excluded); the
          // continuation hooks carry the format ops + the registry-resolved builder. Per-request ledger.
          // The driver's continuation branch is inert unless all three (ledger + extractor + hooks) are wired.
          committedBlocksLedger: createCommittedBlocksLedger(),
          extractCommittedBlocks: extractAnthropicCommittedBlocks,
          ...(getContinuationBuilder("anthropic") && {
            continuation: {
              enabled: resolveContinuation("anthropic").enabled,
              message: resolveContinuation("anthropic").message,
              isMessageStart: isAnthropicMessageStart,
              isContentBlockStart: isAnthropicContentBlockStart,
              remap: remapAnthropicBlockIndex,
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by the `&&` above
              buildRequest: getContinuationBuilder("anthropic")!,
            },
          }),
          // H2 (a terminal upstream `error` frame) is a clean drain WITHOUT message_stop — the same
          // shape as an RST-truncation. This lets the buffered sink COMMIT it (the handler then fails
          // via acc.streamError, mirroring live) instead of wastefully retrying it as a truncation.
          retryCap: resolveBufferedCaps("anthropic").maxRetries,
          bufferCapBytes: resolveBufferedCaps("anthropic").bufferCapBytes,
          // Vendor label the driver injects into onBufferedResolve's `meta.vendor` → the vendor-keyed
          // telemetry bucket. The handler forwards `meta` verbatim (no re-hardcoding the vendor string).
          telemetryVendor: "anthropic",
          // L2 escalation (RFC §8, opt-in): on each retry FORCE a progressively aggressive
          // clear_tool_uses (halve the input-token trigger, shrink keep) so the regenerated response
          // is smaller/faster — more likely to finish before the next RST. Independent of
          // context_editing config; request-preparation skips it when the model lacks support.
          ...(state.protectStreamingEscalateContext && {
            escalate: (e: RequestEnvelope, attempt: number): RequestEnvelope =>
              e.with({
                prepareHints: {
                  ...e.prepareHints,
                  contextEscalation: {
                    trigger: Math.max(ESCALATE_MIN_TRIGGER, Math.floor(state.contextEditingTrigger / 2 ** attempt)),
                    keepTools: Math.max(1, state.contextEditingKeepTools - attempt),
                    keepThinking: Math.max(1, state.contextEditingKeepThinking),
                  },
                },
              }),
          }),
        })
      : await driver.runResponseSink(upstream, env, liveReconcilingSink(sink, anchorHooks, anchorState), {
          wireAllocationPort: getDownstreamDeliverySession(sink)?.allocationPort,
        })

    const candidate = anthropicCandidateSnapshot(driver, upstream)
    if (candidate.kind !== "anthropic-direct") throw new Error("[Anthropic:v4] wrong candidate response session kind")
    const { acc, terminalObserver, sseEvents, streamState } = candidate

    recordForwarded() // before any ctx.settle (settle finalizes the entry); finally re-guards a throw
    // Flush the COMMITTED attempt's tool-input repair outcomes once (telemetry + feature tag + log).
    // Per-attempt outcomes were reset in onAttemptReset, so only the committed attempt's remain — the
    // counters reflect per-request outcomes, not the buffered-retry count. The unrepairable fail-gate
    // below reads the derived `unrepairableToolInput` (this does not clear it).
    flushToolInputRepairObservability(env.ctx)
    if (outcome.kind === "delivery-finished") {
      recordForwarded()
      return
    }
    if (outcome.kind === "settled-abort") {
      // Client disconnected mid-stream — the stream is dead, write ZERO further bytes
      // (B0-d). Settle as aborted (forwarded snapshot guaranteed by the finally).
      consola.debug("[Stream] Client disconnected mid-stream — recording aborted")
      env.ctx.abort(acc.model || model, { usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens }, stop_reason: acc.stopReason || undefined })
      sink.finalize?.()
      return
    }

    if (outcome.kind === "stream-error") {
      // H3 — the upstream iterable (or a sink write) threw a non-abort error. Synthesize the
      // Anthropic error frame + record it into the forwarded track (the client receives it, so
      // it belongs in `inboundResponse.sseEvents`), THEN settle. Ordering is load-bearing:
      // writeSynthetic samples the frame into `forwardedSseEvents`, recordForwarded snapshots it,
      // and only then does ctx.fail() freeze `inboundResponse` — a post-fail snapshot would miss it.
      const error = outcome.error
      logUpstreamStreamOutcomeError(outcome, { model: acc.model || model, streamState, acc, sseEvents })
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorType = anthropicStreamErrorType(error)
      // §10.5 gap (whole-branch review I-1): the live pump can stream-error BEFORE the first real
      // content_block_start (a delayed-commit stall injected the anchor, then the upstream body threw) —
      // reconcileLiveFrame never got to close the anchor, so it is still OPEN. Close it off (stop@0) BEFORE
      // the error frame or the client is left with a dangling block. Idempotent + inert (shared anchorClosed
      // guard): a no-op when reconcile already closed it, or when no anchor was injected.
      await closeAnchorIfOpen(sink, anchorHooks, anchorState)
      await sink
        .writeSynthetic?.(
          shapeRawStreamErrorFrame(
            errorType,
            errorMessage,
            {
              event: "error",
              data: JSON.stringify({ type: "error", error: { type: errorType, message: errorMessage } }),
            },
            env.ctx,
            { terminus: "stream-error", leg: "direct" },
          ),
        )
        .catch(() => undefined)
      recordForwarded()
      // C1: preserve the partial content accumulated before the throw (mirrors the
      // truncation/refusal branches) so pre-abort thinking blocks aren't lost to null.
      const partial = buildAnthropicResponseData(acc, model)
      env.ctx.fail(acc.model || model, error, {
        usage: partial.usage,
        stop_reason: partial.stop_reason,
        stopDetails: partial.stopDetails,
        content: partial.content,
      })
      sink.finalize?.()
      return
    }

    // outcome.kind === "complete" — the upstream drained cleanly.
    const summaryParts = [`↓${streamState.bytesIn}B ${streamState.eventsIn}ev in ${Date.now() - streamState.streamStartMs}ms`]
    if (acc.toolSearchRequests > 0) summaryParts.push(`tool_search:${acc.toolSearchRequests}`)
    const ctxEdits = summarizeAppliedEdits(acc.appliedContextEdits)
    if (ctxEdits.count > 0) {
      summaryParts.push(`ctx_cleared:${ctxEdits.clearedInputTokens}tok×${ctxEdits.count}`)
      env.ctx.recordFeature("context-edits-applied", { count: ctxEdits.count, clearedInputTokens: ctxEdits.clearedInputTokens, types: ctxEdits.types })
    }
    consola.debug(`[Stream] Completed: ${summaryParts.join(" ")}`)

    if (acc.streamError) {
      // H2 — a terminal upstream `error` SSE event (a clean drain, never a thrown error → outcome is
      // `complete`). When error-shaping is on, the `errorFrameCanonical` S5 rewrite already RESHAPED the
      // forwarded frame into a canonical Anthropic envelope before it reached the client (off = forwarded
      // verbatim); either way the client got the frame. This branch only settles ctx.fail from the
      // upstream-original `acc.streamError` (acc sees pre-rewrite frames) — it writes NO frame itself.
      consola.error(`[Stream] Upstream error for ${acc.model || model}: ${acc.streamError.type} — ${acc.streamError.message}`)
      // C1: preserve the partial content accumulated before the terminal error frame (mirrors
      // the truncation/refusal branches) so pre-abort thinking blocks aren't lost to null.
      const partial = buildAnthropicResponseData(acc, model)
      env.ctx.fail(acc.model || model, new Error(`${acc.streamError.type}: ${acc.streamError.message}`), {
        usage: partial.usage,
        stop_reason: partial.stop_reason,
        stopDetails: partial.stopDetails,
        content: partial.content,
      })
      sink.finalize?.()
    } else if (
      isContentlessRefusal(acc.stopReason, hasClientVisibleContent(acc.contentBlocks))
      && (env.ctx.refusalPolicy.mode !== "refusal" || acc.sawMessageStop)
    ) {
      // Contentless refusal, ANY disposition. The S5 rewrite layer already put the chosen wire shape
      // on the forwarded track (suppression's end_turn turn, error's `event: error` frame, or the
      // untouched upstream refusal); the handler OWNS the terminal state + observability here.
      //
      // Derived from THIS candidate's own accumulator (upstream-original frames — `acc.stopReason`
      // is the genuine "refusal") plus the request's FROZEN policy. Both this layer and the rewriter
      // are pure functions of the same immutable inputs, so they cannot disagree even if a concurrent
      // request hot-reloads config mid-stream, and concurrent hedge candidates each judge their own
      // stream instead of racing over one shared slot.
      //
      // MUST precede the truncation branch: in a rewriting mode the rewriter already emitted this
      // stream's single COMPLETE terminus (synthetic text + end_turn delta + its own message_stop),
      // so appending a second one would hand the client `message_delta(end_turn)` followed by
      // `event: error`. The `mode !== "refusal" || sawMessageStop` guard keeps that honest — in
      // passthrough mode with a truncated stream NO terminus was emitted, so we deliberately fall
      // through to the truncation branch (the client still needs a terminator).
      //
      // The verdict is FAILED in every mode: the client receiving a clean synthesized turn is a
      // PRESENTATION policy, not a claim that the turn produced anything. The upstream leg SUCCEEDED
      // (a complete 200 refusal stream), so `upstreamSucceeded` keeps outboundResponse honest and
      // routes the verdict to failureReason.
      const mode = env.ctx.refusalPolicy.mode
      const partial = buildAnthropicResponseData(acc, model)
      const summary = refusalSummary(extractRefusalDetail(acc.stopDetails))
      consola.error(`[REFUSAL] ${summary} for ${acc.model || model} -> wire=${mode}, recorded as failed`)
      env.ctx.recordFeature(REFUSAL_FEATURE_BY_MODE[mode], { category: refusalCategoryForDiagnostics(acc.stopDetails) })
      env.ctx.fail(
        acc.model || model,
        new Error(summary),
        { usage: partial.usage, stop_reason: partial.stop_reason, stopDetails: partial.stopDetails, content: partial.content },
        { upstreamSucceeded: true },
      )
      sink.finalize?.()
    } else if (env.ctx.unrepairableToolInput !== null) {
      // A malformed tool_use input could not be repaired (Layer 1 strip + Layer 2 jsonrepair both
      // failed during S5) — forwarding the broken JSON hands the client an unparseable tool call.
      // Settle as FAIL with a precise root cause. MUST precede the truncation branch: an unrepairable
      // block is a more specific diagnosis than a missing message_stop (the two can co-occur), and the
      // truncation branch would otherwise emit a less-precise error frame. The flag rides the ctx (not
      // acc, which is rebuilt across buffered-retry attempts); History keeps the upstream-original
      // sseEvents. The upstream leg SUCCEEDED (complete 200 stream) — the proxy rejected the malformed
      // content, so `upstreamSucceeded` keeps outboundResponse honest + routes the verdict to
      // failureReason. Order: writeSynthetic (samples the client-received error frame) → recordForwarded
      // → fail (freezes inboundResponse) — a post-fail snapshot would miss the error frame.
      const tool = env.ctx.unrepairableToolInput
      const partial = buildAnthropicResponseData(acc, model)
      consola.error(`[REPAIR] unrepairable malformed tool_use input for ${acc.model || model} (tool=${tool}) -> recorded as error`)
      // §10.5 close-off (I-1): balance any still-open anchor before the error terminus. Almost always inert
      // here — an unrepairable tool_use requires a real content_block_start (which reconcile already closed
      // the anchor at) — but the shared idempotent guard keeps every error-frame terminus uniformly safe.
      await closeAnchorIfOpen(sink, anchorHooks, anchorState)
      await sink
        .writeSynthetic?.(anthropicErrorFrame("invalid_request_error", `Tool call input for ${tool} was malformed and could not be repaired`))
        .catch(() => undefined)
      recordForwarded()
      env.ctx.fail(
        acc.model || model,
        new Error(`unrepairable malformed tool_use input (tool=${tool})`),
        { usage: partial.usage, stop_reason: partial.stop_reason, stopDetails: partial.stopDetails, content: partial.content },
        { upstreamSucceeded: true },
      )
      sink.finalize?.()
    } else if (!acc.sawMessageStop) {
      // Upstream truncation: a clean EOF WITHOUT the mandatory `message_stop` terminator
      // (GHC mid-stream cutoff). The driver sees a clean drain → `complete`, but the message
      // never finished. Settle as FAIL (not a silent `[ OK ]`) — preserving the accumulated
      // partial (richest-data-flow) — and emit a synthetic Anthropic `error` so the client SDK
      // gets a clean terminator. See docs/spec/upstream-stream-truncation-detection.md. Truncation
      // is a genuine UPSTREAM failure (partial stream), so outboundResponse stays success:false.
      // Order: writeSynthetic (samples the error frame) → recordForwarded → fail (see H3 branch).
      const partial = buildAnthropicResponseData(acc, model)
      consola.error(`[Stream] Upstream truncated for ${acc.model || model}: closed after ${streamState.eventsIn} events without message_stop`)
      logUpstreamStreamTruncation("Upstream stream truncated before completion (no message_stop)", { model: acc.model || model, streamState, acc, sseEvents })
      // §10.5 gap (I-1): the live pump can truncate (clean EOF, no message_stop) BEFORE the first real
      // content_block_start — a delayed-commit stall injected the anchor, then the upstream closed silently.
      // reconcile never closed the anchor, so close it off (stop@0) before the error frame. Idempotent (a
      // real first block already closed it → no-op) + inert (no anchor injected → byte-equivalent).
      await closeAnchorIfOpen(sink, anchorHooks, anchorState)
      await sink
        .writeSynthetic?.(
          shapeRawStreamErrorFrame(
            "api_error",
            "Upstream stream truncated before completion (no message_stop)",
            {
              event: "error",
              data: JSON.stringify({ type: "error", error: { type: "api_error", message: "Upstream stream truncated before completion (no message_stop)" } }),
            },
            env.ctx,
            { terminus: "truncation", leg: "direct" },
          ),
        )
        .catch(() => undefined)
      recordForwarded()
      env.ctx.fail(acc.model || model, new Error("upstream stream truncated: closed without message_stop"), {
        usage: partial.usage,
        stop_reason: partial.stop_reason,
        stopDetails: partial.stopDetails,
        content: partial.content,
      })
      sink.finalize?.()
    } else {
      if (isAnthropicMaxTokensTerminal(acc.stopReason)) {
        const truncationClass = classifyMaxTokensTruncation(terminalObserver)
        if (truncationClass !== undefined) {
          // P0 is observation-only: record the actual upstream terminal before ctx.complete freezes
          // the history entry, without suppressing or rewriting any client-visible frame.
          env.ctx.recordMaxTokensTruncation({
            truncationClass,
            roundsAttempted: 1,
            roundsSucceeded: 0,
            continuedTokens: 0,
            perRoundStopReason: [acc.stopReason],
            clientVisibleStopReason: acc.stopReason,
            suppressedMaxTokens: false,
            visibilityMode: "passthrough",
          })
        }
      }
      env.ctx.complete(buildAnthropicResponseData(acc, model))
      sink.finalize?.()
    }
  } catch (error) {
    const failedCandidate = anthropicCandidateSnapshot(driver, upstream)
    if (failedCandidate.kind !== "anthropic-direct") throw error
    const { acc } = failedCandidate
    // Unexpected throw from the driver/sink (not a returned outcome): surface a synthetic error
    // frame + record it into the forwarded track, THEN settle so the persisted inboundResponse
    // includes the client-received error frame (writeSynthetic → recordForwarded → fail).
    const msg = error instanceof Error ? error.message : String(error)
    // §10.5 close-off (I-1): an unexpected throw is also an error terminus — balance any open anchor before
    // the synthetic error frame (idempotent + inert via the shared anchorClosed guard).
    await closeAnchorIfOpen(sink, anchorHooks, anchorState)
    await sink.writeSynthetic?.({ event: "error", data: JSON.stringify({ type: "error", error: { type: "api_error", message: msg } }) }).catch(() => undefined)
    recordForwarded()
    env.ctx.fail(acc.model || model, error, {
      usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens },
      stop_reason: acc.stopReason || undefined,
    })
    sink.finalize?.()
  } finally {
    recordForwarded()
  }
}

// MARKER_DIAG_9z

// ============================================================================
// Translate-leg streaming pump (FORWARD anthropic→cc/responses — Phase 4 T4.2/T4.3)
// ============================================================================

/** Is a flushed translator frame a message-level terminator (message_delta / message_stop)? */
function isMessageTerminatorFrame(frame: ClientFrame): boolean {
  if (typeof frame.data !== "string") return false
  try {
    const t = (JSON.parse(frame.data) as { type?: unknown }).type
    return t === "message_delta" || t === "message_stop"
  } catch {
    return false
  }
}

/**
 * Stream pump for a FORWARD translate leg (`@cc` / `@responses`) — the upstream is a CC / Responses SSE
 * stream, the codec's `renderResponse` translates each upstream frame to Anthropic frame(s) (T4.1), and
 * `flushResponse` drains the terminal `message_delta` + `message_stop` (the per-frame render has no
 * stream-end hook — mirrors the gemini / responses codecs). This handler:
 *   - reuses the SAME anchored keepalive sink + live reconcile the direct pump uses (constraint #3: the
 *     client is still Claude Code, so the 300s no-real-content deadline + the anchor/prelude three-way
 *     reconcile apply to the TRANSLATED Anthropic stream — it does NOT mirror gemini's no-heartbeat path),
 *   - accumulates the RAW UPSTREAM frame (CC / Responses) into the OUTBOUND-leg accumulator via
 *     `onUpstreamFrame`, so `outboundResponse` stays honest (the upstream's real shape — RFC §4.1 /
 *     richest-data-flow "后端存储必须完整"), while the client track (`inboundResponse.sseEvents`) is the
 *     forwarded Anthropic frames the sink samples,
 *   - settles from `candidate session renderer meta` (out-of-band terminal stop_reason + net usage): a clean drain
 *     WITHOUT a stop_reason is an upstream truncation (F2 — the CC stream ended with no finish_reason),
 *     failed with a synthetic Anthropic error terminator (mirrors the direct pump's truncation gate).
 *
 * L2 buffered-retry (`protect_streaming_generation`) is NOT applied on the translate leg — the buffered
 * commit's `sawMessageStop` gate reads the Anthropic terminator, which here is synthesized by
 * `flushResponse` AFTER the render loop (the upstream CC stream carries a `finish_reason`, not an
 * Anthropic `message_stop`), so buffered-retry on the translate leg is deferred to a follow-up
 * (docs/todo/deferred-backlog.md). The LIVE path is byte-correct and complete for unlocking forward
 * streaming (constraint #4: only the forward leg is unlocked; reverse streaming stays Phase 5).
 */
async function pumpTranslateLegStreamingV4(opts: PumpAnthropicStreamingDispatchOptions): Promise<void> {
  const { sink, forwardedSseEvents, driver, upstream, env, anchorHooks, anchorState } = opts
  // The translate-leg env.body is the CC-canonical wire body (translateOut delegated to the hub), so it
  // carries the resolved model name; fall back to a literal when absent (defensive, never for a real leg).
  const model = (env.body as { model?: string }).model ?? "unknown"

  const recordForwarded = (): void => env.ctx.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })

  try {
    // LIVE owns-sink: the driver drives codec.renderResponse (CC/Responses→Anthropic per-frame) + writes
    // the Anthropic frames to the reconciling sink (the anchor prelude's three-way message_start reconcile
    // + block +1 remap applies — the translator's own message_start is dropped when the anchor injected one).
    // The SAME reconciling sink is reused for the stream-end `flushResponse` drain below: the translator
    // closes its LAST open block only at flush (a finish_reason chunk does not close it), so that terminal
    // `content_block_stop` MUST pass through the SAME +1 remap the live loop applied to its matching
    // `content_block_start` — writing it to the raw sink would emit it at the un-remapped index (block-index
    // mismatch / dangling block) under `empty_text` anchor. reconcile leaves index-less message_delta /
    // message_stop unchanged, and is a transparent passthrough when no anchor was injected (byte-equivalent).
    const clientSink = liveReconcilingSink(sink, anchorHooks, anchorState)
    const outcome = await driver.runResponseSink(upstream, env, clientSink, {
      wireAllocationPort: getDownstreamDeliverySession(sink)?.allocationPort,
    })

    const candidate = anthropicCandidateSnapshot(driver, upstream)
    if (candidate.kind !== "anthropic-translate") throw new Error("[Anthropic:v4:translate] wrong candidate response session kind")
    const { ccAcc, respAcc, diag, meta } = candidate
    const outboundResponseData = (): ReturnType<typeof buildOpenAIResponseData> =>
      ccAcc ? buildOpenAIResponseData(ccAcc, model) : buildResponsesResponseData(respAcc as NonNullable<typeof respAcc>, model)

    if (outcome.kind === "delivery-finished") {
      recordForwarded()
      return
    }
    if (outcome.kind === "settled-abort") {
      recordForwarded()
      consola.debug("[Anthropic:v4:translate] Client disconnected mid-stream — recording aborted")
      env.ctx.abort(model, {
        usage: { input_tokens: meta?.usage.input_tokens ?? 0, output_tokens: meta?.usage.output_tokens ?? 0 },
        ...(meta?.stopReason && { stop_reason: meta.stopReason }),
      })
      sink.finalize?.()
      return
    }

    if (outcome.kind === "stream-error") {
      // H3 — the upstream iterable (or a sink write) threw. Close any open anchor, write a synthetic
      // Anthropic error terminator, snapshot the forwarded track, THEN fail (order load-bearing — ctx.fail
      // freezes inboundResponse; a post-fail snapshot misses the error frame).
      const error = outcome.error
      const errUsage = meta?.usage
      logUpstreamStreamOutcomeError(outcome, {
        model,
        streamState: { streamStartMs: diag.startedAtMs, bytesIn: diag.bytesIn, currentBlockType: "" },
        acc: { inputTokens: errUsage?.input_tokens ?? 0, outputTokens: errUsage?.output_tokens ?? 0 },
        sseEvents: diag.sseEvents,
      })
      await closeAnchorIfOpen(sink, anchorHooks, anchorState)
      // G-3 (FIX-2): the translate leg's client IS an Anthropic /v1/messages client, so its H3 error
      // terminator is owned by the same canonical builder (byte-identical to the former hand-built JSON;
      // CF-2 golden-locked off).
      await sink
        .writeSynthetic?.(
          shapeRawStreamErrorFrame(
            anthropicStreamErrorType(error),
            error instanceof Error ? error.message : String(error),
            {
              event: "error",
              data: JSON.stringify({
                type: "error",
                error: { type: anthropicStreamErrorType(error), message: error instanceof Error ? error.message : String(error) },
              }),
            },
            env.ctx,
            { terminus: "stream-error", leg: "translate" },
          ),
        )
        .catch(() => undefined)
      recordForwarded()
      env.ctx.fail(model, error, outboundResponseData())
      sink.finalize?.()
      return
    }

    // outcome.kind === "complete" — the upstream drained cleanly. The terminal stop_reason is the F2
    // signal: undefined ⇒ the CC/Responses stream ended with NO finish_reason ⇒ truncation.
    // N3 (RFC 2026-07-14-anthropic-responses-direct-bridge §3 subtask C): the direct Responses→Anthropic
    // streaming bridge's meta is a superset carrying `contentFiltered` — record the SAME ctx marker the
    // non-streaming leg already records (codec.ts renderResponseNonStreaming), so a content-filtered
    // streaming completion stays observably distinguishable even though its wire stop_reason is end_turn
    // (Anthropic has no content_filter stop_reason — the marker IS the distinguishability, not the wire value).
    if (meta?.contentFiltered) env.ctx.recordFeature("translated-content-filter")
    if (meta?.stopReason === undefined) {
      // The processor finish boundary already forwarded block-close frames through the reconciling
      // sink and suppressed clean message terminators.
      await closeAnchorIfOpen(sink, anchorHooks, anchorState)
      // G-3 (FIX-2): translate-leg truncation terminator via the canonical builder (byte-identical to the
      // former hand-built JSON — note the translate leg's message says "no finish_reason", the CC/Responses
      // terminator, distinct from the direct pump's "no message_stop"; CF-2 golden-locked off).
      await sink
        .writeSynthetic?.(
          shapeRawStreamErrorFrame(
            "api_error",
            "Upstream stream truncated before completion (no finish_reason)",
            {
              event: "error",
              data: JSON.stringify({ type: "error", error: { type: "api_error", message: "Upstream stream truncated before completion (no finish_reason)" } }),
            },
            env.ctx,
            { terminus: "truncation", leg: "translate" },
          ),
        )
        .catch(() => undefined)
      recordForwarded()
      consola.error(`[Anthropic:v4:translate] Upstream truncated for ${model}: drained without a finish_reason`)
      const truncUsage = meta?.usage
      logUpstreamStreamTruncation("Upstream stream truncated before completion (no finish_reason)", {
        model,
        streamState: { streamStartMs: diag.startedAtMs, bytesIn: diag.bytesIn, currentBlockType: "" },
        acc: { inputTokens: truncUsage?.input_tokens ?? 0, outputTokens: truncUsage?.output_tokens ?? 0 },
        sseEvents: diag.sseEvents,
      })
      env.ctx.fail(model, new Error("upstream stream truncated: closed without finish_reason"), outboundResponseData())
      sink.finalize?.()
      return
    }

    // The processor finish boundary already emitted the translator's block-close and message terminal
    // frames through the same reconciling sink.
    recordForwarded()
    env.ctx.complete(outboundResponseData())
    sink.finalize?.()
  } catch (error) {
    // Unexpected throw from the driver/sink: synthesize an Anthropic error terminator + record it, THEN fail.
    const failedCandidate = anthropicCandidateSnapshot(driver, upstream)
    if (failedCandidate.kind !== "anthropic-translate") throw error
    const { ccAcc, respAcc } = failedCandidate
    const failedResponseData = (): ReturnType<typeof buildOpenAIResponseData> =>
      ccAcc ? buildOpenAIResponseData(ccAcc, model) : buildResponsesResponseData(respAcc as NonNullable<typeof respAcc>, model)
    await closeAnchorIfOpen(sink, anchorHooks, anchorState)
    await sink
      .writeSynthetic?.({
        event: "error",
        data: JSON.stringify({ type: "error", error: { type: "api_error", message: error instanceof Error ? error.message : String(error) } }),
      })
      .catch(() => undefined)
    recordForwarded()
    env.ctx.fail(model, error, failedResponseData())
    sink.finalize?.()
  } finally {
    recordForwarded()
  }
}
