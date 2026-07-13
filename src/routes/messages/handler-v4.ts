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
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  AnchorHooks,
  AnchorState,
  ClientFrame,
  ClientSink,
  DriverRequestResult,
  RetryStrategy,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type {
  //
  MessagesPayload,
  StreamEvent,
} from "~/types/api/anthropic"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { bridgeClientAbort } from "~/lib/abort-bridge"
import {
  //
  extractAppliedEdits,
  summarizeAppliedEdits,
} from "~/lib/anthropic/applied-context-edits"
import { selectForwardableResponseHeaders } from "~/lib/anthropic/header-policy"
import {
  //
  anchorDeltaFrame,
  anchorStartFrame,
  anchorStopFrame,
  closeAnchorIfOpen,
  makeSyntheticAnchorInjector,
  makeSyntheticEnvelopeInjector,
  remapAnthropicBlockIndex,
  syntheticMessageStartFrame,
} from "~/lib/anthropic/keepalive-anchor"
import {
  //
  ANTHROPIC_PING,
  resolveAnthropicKeepalive,
} from "~/lib/anthropic/keepalive-frame"
import { makeReconcilingSink } from "~/lib/anthropic/live-reconcile"
import { buildMessageMapping } from "~/lib/anthropic/message-mapping"
import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { recordProtectStreamingOutcome } from "~/lib/anthropic/protect-streaming-stats"
import {
  //
  DEFAULT_REFUSAL_ERROR_TYPE,
  isThinkingOnlyRefusal,
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
import { ALL_RESPONSE_REWRITES } from "~/lib/codec/response-rewrite-registry"
import { assembleStrategiesForEndpoint } from "~/lib/codec/strategy-registry"
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
import { makeSseSink } from "~/lib/pipeline/client-sink"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { anthropicNonStreamingTruncation } from "~/lib/pipeline/non-streaming-completeness"
import { createStreamRepetitionChecker } from "~/lib/repetition-detector"
import {
  //
  buildAnthropicResponseData,
  buildOpenAIResponseData,
  buildResponsesResponseData,
} from "~/lib/request"
import { state } from "~/lib/state"
import { processAnthropicSystem } from "~/lib/system-prompt"
import { createUpstreamHttpTransport } from "~/lib/transport/http-transport"

import {
  //
  anthropicErrorFrame,
  anthropicHttpErrorFrame,
  anthropicRejectErrorFrame,
  classifyPostCommitAbort,
} from "./post-commit-error"
import { retryMetaFeature } from "./retry-meta-feature"
import {
  //
  anthropicStreamErrorType,
  logUpstreamStreamError,
  recordUpstreamFrame,
  type StreamPumpState,
} from "./streaming-pump"

/** Anthropic's effort-learning strategy is real (not inert); learning budget = 32 (legacy MAX_LEARNING_RETRIES). */
const MAX_LEARNING_RETRIES = 32

/** L2 escalation floor: the most aggressive `clear_tool_uses` input-token trigger we'll set on a retry. */
const ESCALATE_MIN_TRIGGER = 4096

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
  const { name: resolvedName, routeOverride } = resolveModelTarget(clientModel)
  const selectedModel = state.modelIndex.get(resolvedName)

  // Snapshot the client's raw inbound body BEFORE the system-prompt injection —
  // this is the history `originalBodyForHistory` (the codec records it as the
  // inboundRequest; the wire body below is the server-modified form).
  const clientRaw = structuredClone(payload)

  // System-prompt collection + config overrides (async, non-idempotent) on the
  // model-resolved wire body, BEFORE the sync codec.parse.
  const wireBody: MessagesPayload = { ...payload, model: resolvedName }
  if (wireBody.system) wireBody.system = await processAnthropicSystem(wireBody.system, resolvedName, "anthropic")

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

/**
 * Build the driver's per-request retry-strategy stack for the Anthropic /v1/messages route, keyed
 * by the OUTBOUND leg (`env.targetEndpoint`), resolved AFTER `translateOut` so `env.body` is already
 * the target-leg body. This is the SINGLE production factory (the driver invokes it as `deps.strategies`);
 * exported so tests can drive the REAL seam instead of injecting `strategies:[]`.
 *
 *   - DIRECT / reverse `/v1/messages`: the ANTHROPIC stack (RFC §7.1 / W-strategies-builder). The
 *     Anthropic supply is decoupled from the route codec (resanitize/betaProbe/baseline), so a reverse
 *     leg could fill the SAME supply from the hub. `env.body` is the Anthropic body → truncation baseline
 *     is the codec's captured baseline (falls back to `env.body`).
 *   - FORWARD translate `/chat/completions` | `/responses` | `ws:/responses` (Phase 7): the CC stack.
 *     `env.body` is post-`translateOut`, i.e. already the CC-shaped body the hub produced, so it is the
 *     correct auto-truncate baseline (the CC→Responses wire step is deferred to `prepareWire`, so the
 *     Responses legs still truncate on the CC shape — parity with the openai-cc/gemini via-responses legs).
 *     Before Phase 7 this path threw `no strategy builder registered`, 500ing every `@cc`/`@responses`
 *     forward request.
 */
export function buildMessagesDriverStrategies(
  env: RequestEnvelope,
  deps: { codec: ReturnType<typeof createAnthropicCodec>; betaProbe: ReturnType<typeof createBetaProbe> },
): ReadonlyArray<RetryStrategy> {
  const { codec, betaProbe } = deps
  if (env.targetEndpoint === ENDPOINT.MESSAGES) {
    // parse resolves the factory AFTER parse populated resanitize, so it is present here; the guard is
    // defensive (an unreachable parse failure would have thrown before the factory runs).
    const resanitize = codec.getResanitize()
    if (!resanitize) throw new Error("[Anthropic:v4] resanitize chain unavailable — codec.parse did not run")
    return assembleStrategiesForEndpoint(env.targetEndpoint, {
      anthropic: {
        originalPayload: codec.getTruncateBaseline() ?? (env.body as MessagesPayload),
        resanitize,
        model: env.model as Model | undefined,
        maxRetries: state.maxReactiveRetries,
        betaProbe,
      },
    })
  }

  // FORWARD translate leg (anthropic→cc/responses): the CC strategy stack off the hub-translated CC body.
  return assembleStrategiesForEndpoint(env.targetEndpoint, {
    cc: {
      originalPayload: env.body as ChatCompletionsPayload,
      model: env.model as Model | undefined,
      maxRetries: state.maxReactiveRetries,
      label: env.targetEndpoint === ENDPOINT.RESPONSES ? "Anthropic(→Responses)" : "Anthropic(→CC)",
    },
  })
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
    // S3 — the Anthropic request sanitize chain + its recordings, lifted from
    // codec.parse into a per-request RequestRewrite (RFC §4.A0). The codec owns them
    // (they close over preprocessInfo + write initialSanitizationInfo back).
    requestRewrites: codec.getRequestRewrites(),
    // S5 — the FULL-FORMAT response-rewrite union (RFC §7.1); the driver's
    // `assembleResponseRewrites` filters it to the outbound leg by each rewrite's
    // `targetEndpoint`-keyed `appliesTo`. For anthropic-direct (targetEndpoint===/v1/messages)
    // that subset is exactly the Anthropic chain (recover/thinking/decode/filter/refusal) — the
    // per-route array this replaced — so forwarded bytes are unchanged.
    responseRewrites: ALL_RESPONSE_REWRITES,
    strategies: (env) => buildMessagesDriverStrategies(env, { codec, betaProbe }),
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
      })
      try {
        await pumpAnthropicStreamingDispatch({ sink, buffered, forwardedSseEvents, streamStartMs, driver, codec, upstream, env, anchorHooks, anchorState })
      } finally {
        sink.close?.() // symmetric with the commit path: keep the heartbeat-timer-stop invariant local
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
  if (state.streamCommitAfterSec > 0) {
    let windowTimer: ReturnType<typeof setTimeout> | undefined
    const windowFired = new Promise<"window">((res) => {
      windowTimer = setTimeout(() => res("window"), state.streamCommitAfterSec * 1000)
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
    const pingSec = state.streamKeepalivePingSec > 0 ? state.streamKeepalivePingSec : state.protectStreamingHeartbeat
    const forwardedSseEvents: Array<SseEventRecord> = []
    const streamStartMs = Date.now()
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
          // Discriminate by SIGNAL STATE (§4.2.1): client/reaper/timeout are all generic AbortErrors,
          // and a pre-response reaper-cancel is NOT a StreamReaperCancelError (that's stream-drain only).
          const kind = classifyPostCommitAbort(clientAbort.signal.aborted, ctx?.lifecycleSignal.aborted ?? false)
          if (kind === "client-abort") {
            ctx?.abort(resolvedName) // (e) client gone — zero further bytes, no 499 (already 200)
            return
          }
          // (f) reaper-cancel (reaper already settled it; the `settled` guard dedups) / (d) timeout.
          ctx?.fail(resolvedName, error)
          await closeAnchorIfOpen(sink, anchorHooks, anchorState) // balance an open pre-response anchor before the error terminus (§10.5)
          await sink.writeSynthetic?.(
            kind === "reaper-cancel" ?
              anthropicErrorFrame("api_error", "Request cancelled by the stale-request reaper")
            : anthropicErrorFrame("api_error", "Upstream timed out before sending response headers"),
          )
          return
        }
        if (error instanceof HTTPError) {
          // (c) upstream 4xx/5xx — the dominant POST-COMMIT divergence. The rich frame preserves
          // error.type (+ retry_after) so the client SDK still branches correctly (Q2 §4.2.5).
          ctx?.fail(resolvedName, error)
          await closeAnchorIfOpen(sink, anchorHooks, anchorState) // balance an open pre-response anchor before the error terminus (§10.5)
          await sink.writeSynthetic?.(anthropicHttpErrorFrame(error))
          return
        }
        ctx?.fail(resolvedName, error) // unknown non-HTTP, non-abort
        await closeAnchorIfOpen(sink, anchorHooks, anchorState) // balance an open pre-response anchor before the error terminus (§10.5)
        await sink.writeSynthetic?.(anthropicErrorFrame("api_error", error instanceof Error ? error.message : String(error)))
        return
      }
      if (!result.ok) {
        // (b) decideRoute reject — RESOLVE not throw (C2), the try/catch above can't catch it.
        const ctx = codec.getContext()
        ctx?.setForwardedResponse({ sseEvents: [...forwardedSseEvents] }) // forwarded pings before settling (richest-data-flow)
        ctx?.fail(resolvedName, new HTTPError(result.rejection.reason, result.rejection.status, result.rejection.reason))
        await closeAnchorIfOpen(sink, anchorHooks, anchorState) // balance an open pre-response anchor before the error terminus (§10.5, M1 — was missing in the first plan)
        await sink.writeSynthetic?.(anthropicRejectErrorFrame(result.rejection.status, result.rejection.reason))
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
      sink.close?.()
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
 *     pre-initial-sanitize); mapping effective ← `codec.getLatestEffectiveMessages()`
 *     (sampleRequest-captured, the `action.env.body === action.payload` invariant
 *     makes it the retry's body). (The `thinking` feature is NOT rebuilt here — it
 *     is emitted per-attempt by `prepareWire` as a terminal `{requested, effective}`
 *     dimension; see codec.ts / observability console sink.)
 *   - sanitization / strippedBetas / probedBetas ← `meta` (onMeta, post-gate).
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

  const retryMessageMapping =
    baseline && effectiveMessages ? buildMessageMapping(baseline.messages, effectiveMessages as MessagesPayload["messages"]) : undefined

  const strippedCacheControl = codec.getLatestStrippedCacheControlSubfields()
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

  // error mode: a thinking-only refusal surfaces as an HTTP error body (not a 200) + ctx.fail.
  // Detected on the UPSTREAM-ORIGINAL `response` (in error mode transformWhole left it unchanged);
  // mirrors the streaming refusal-error branch + the truncation fail-gate's header/inbound timing
  // (c.json builds headers -> setInboundResponseHeaders -> fail; never `throw` -- that would skip
  // c.json and drop the inboundResponse leg, see memory hono-onerror-consumes-throws).
  if (
    state.refusalSseRewrite === "error"
    && response.stop_reason === "refusal"
    && !(response.content as ReadonlyArray<{ type: string }>).some((b) => b.type === "text" || b.type === "tool_use")
  ) {
    // Emission point 4 (non-streaming error body): render message/type from config (whole response
    // in hand → all vars incl. thinking_tokens available). Empty type falls back to api_error.
    const errVars = { model: response.model, request_id: reqCtx.id, thinking_tokens: response.usage.output_tokens }
    const errType = state.refusalErrorType === "" ? DEFAULT_REFUSAL_ERROR_TYPE : state.refusalErrorType
    const errorBody = { type: "error", error: { type: errType, message: renderRefusalTemplate(state.refusalErrorMessage, errVars) } }
    // The client receives the 500 error BODY (not the upstream content) — record THAT as the
    // forwarded (proxy→client) response so inboundResponse faithfully mirrors what the client got
    // (the upstream-original thinking blocks are preserved on outboundResponse via fail's partial).
    reqCtx.setForwardedResponse({ content: errorBody })
    applyForwardedAnthropicResponseHeaders(c, upstreamHeaders)
    const errResponse = c.json(errorBody, 500)
    reqCtx.setInboundResponseHeaders(Object.fromEntries(errResponse.headers.entries()))
    reqCtx.setClientResponseStatus(errResponse.status)
    consola.error(`[REFUSAL] upstream thinking-only refusal for ${response.model} -> recorded as error (non-streaming)`)
    reqCtx.recordFeature("refusal-errored")
    // Upstream leg SUCCEEDED (delivered a complete refusal response); the proxy introduced the error
    // verdict → upstreamSucceeded keeps outboundResponse honest + routes the verdict to failureReason.
    reqCtx.fail(
      response.model,
      new Error("upstream thinking-only refusal"),
      {
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined,
          cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? undefined,
        },
        stop_reason: response.stop_reason,
        content: { role: "assistant", content: response.content },
      },
      { upstreamSucceeded: true },
    )
    return errResponse
  }

  reqCtx.setForwardedResponse({ content: { role: "assistant", content: finalResponse.content } })
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
  const failReason = unrepairableTool !== null ? `unrepairable malformed tool_use input (tool=${unrepairableTool})` : truncationReason
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
    content: { role: "assistant", content: response.content },
  }
  if (failReason) {
    // Unrepairable = upstream delivered a COMPLETE 200 body that the proxy rejected → upstreamSucceeded
    // keeps outboundResponse honest + routes the verdict to failureReason. Semantic truncation = an
    // INCOMPLETE upstream body (genuine upstream failure) → stays success:false.
    reqCtx.fail(
      response.model,
      new Error(failReason),
      { usage: responseData.usage, stop_reason: responseData.stop_reason, content: responseData.content },
      unrepairableTool !== null ? { upstreamSucceeded: true } : undefined,
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
    startFrame: anchorStartFrame(),
    stopFrame: anchorStopFrame(),
    deltaFrame: anchorDeltaFrame(),
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
  stream: Parameters<typeof makeSseSink>[0],
  args: {
    onForwarded: (record: SseEventRecord) => void
    streamStartMs: number
    heartbeatSec: number
    clientAbortSignal: AbortSignal
    resolvedName: string
    reqId: string
  },
): { sink: ClientSink; anchorState: AnchorState; anchorHooks: AnchorHooks | undefined } {
  const { onForwarded, streamStartMs, heartbeatSec, clientAbortSignal, resolvedName, reqId } = args
  // Hooks are built for BOTH synthetic-prelude modes (empty_text + enveloped_ping); only `ping` opts out.
  // The mode then selects WHICH injector runs (full anchor vs envelope-only) and whether `anchorBlockOpen`
  // is set — the hooks themselves are the same format primitives.
  const anchorHooks = buildAnthropicAnchorHooks(state.streamKeepaliveMode !== "ping")
  const anchorState: AnchorState = { injected: false, messageStartForwarded: false, anchorBlockOpen: false, anchorClosed: false }
  // Late-bind holder: the injector must read its sink at CALL time (an idle tick), but the sink's options
  // are evaluated before the sink exists — so `getSink` reads this holder, assigned right after construction.
  const sinkHolder: { current: ClientSink | undefined } = { current: undefined }
  // `empty_text` → full anchor injector (message_start + anchor block@0 + empty delta, anchorBlockOpen=true);
  // `enveloped_ping` → envelope-only injector (message_start ONLY, anchorBlockOpen stays false → bare ping
  // after, no block, no remap — spec §10.6).
  const makeInjector = state.streamKeepaliveMode === "enveloped_ping" ? makeSyntheticEnvelopeInjector : makeSyntheticAnchorInjector
  const injectAnchor =
    anchorHooks ? makeInjector({ anchor: anchorHooks, state: anchorState, getSink: () => sinkHolder.current, resolvedName, reqId }) : undefined
  const sink = makeSseSink(stream, {
    onForwarded,
    streamStartMs,
    ...(heartbeatSec > 0 && {
      heartbeat: {
        intervalSec: heartbeatSec,
        pingFrame: resolveAnthropicKeepalive(state.streamKeepaliveMode),
        clientAbortSignal,
        ...(injectAnchor && { injectAnchor }),
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
 *   FORCES a heartbeat (`streamKeepalivePingSec` when set, else `protectStreamingHeartbeat`
 *   fallback). The live path heartbeats only when the operator set `streamKeepalivePingSec`.
 */
function resolveBufferedAndHeartbeat(env: RequestEnvelope): { buffered: boolean; heartbeatSec: number } {
  const anthropicPayload = env.body as MessagesPayload
  const buffered =
    state.protectStreamingGeneration === "on"
    || (state.protectStreamingGeneration === "tool_use_only" && Array.isArray(anthropicPayload.tools) && anthropicPayload.tools.length > 0)
  const forcedHeartbeatSec = state.streamKeepalivePingSec > 0 ? state.streamKeepalivePingSec : state.protectStreamingHeartbeat
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
  const { sink, buffered, forwardedSseEvents, streamStartMs, driver, upstream, env, anchorHooks, anchorState } = opts
  const anthropicPayload = env.body as MessagesPayload
  const model = anthropicPayload.model

  // These four upstream-side accumulators are reset BETWEEN buffered attempts (onAttemptReset):
  // each retry is a fresh generation, so reusing them would double-count usage/tokens/bytes and
  // leak the prior attempt's repetition/sse state. `let` (not `const`) so the reset can rebind
  // them and the closures below read the CURRENT binding.
  let acc = createAnthropicStreamAccumulator()
  let checkRepetition = createStreamRepetitionChecker(model)

  // Raw upstream SSE frames (verbatim) — a local copy for logUpstreamStreamError. The
  // PERSISTED upstream-original track is the driver's (runResponse loop-top, P3.2b; per attempt
  // in buffered mode via ctx.commitAttemptSseEvents). Reset per attempt so the final error log
  // reflects the LAST (failing) attempt's frames, not all attempts concatenated.
  let sseEvents: Array<SseEventRecord> = []
  // `forwardedSseEvents` (what the client ACTUALLY received) is CALLER-OWNED and injected: the sink
  // samples real frames + heartbeat pings into it via `onForwarded`, and the pump snapshots it onto
  // ctx. NOT reset across buffered attempts (RFC §10 correction): the client received one continuous
  // SSE stream, so heartbeat pings from EARLIER (failed) attempts genuinely stay on the wire; content
  // frames enter it only once, at the final commit flush, so they can never double.

  let streamState: StreamPumpState = {
    streamStartMs,
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
  const onAttemptReset = (): void => {
    acc = createAnthropicStreamAccumulator()
    checkRepetition = createStreamRepetitionChecker(model)
    sseEvents = []
    // Discard the prior attempt's tool-input repair outcomes so a discarded buffered attempt's
    // unrepairable/repair signal never leaks into the committed one (audit C1/H1).
    env.ctx.resetRepairOutcomesForAttempt()
    streamState = {
      streamStartMs: streamState.streamStartMs,
      bytesIn: 0,
      eventsIn: 0,
      currentBlockType: "",
      firstEventLogged: false,
      recoverFeatureLogged: false,
    }
  }

  // The await is INSIDE the try so a throw from the driver/sink still records forwarded + settles the
  // entry (catch) — no dangling entry, no lost keepalive track. finally re-guards. The driver returns
  // a ResponseOutcome on the handled paths; only an unexpected throw reaches catch.
  try {
    const outcome =
      buffered ?
        await driver.runResponseBufferedSink(upstream, env, sink, {
          onUpstreamFrame,
          // Buffered synthetic-prelude keepalive (spec 2026-07-08 / §10.6): the handler's injector lazily
          // forwards a message_start prelude via the sink's heartbeat.injectAnchor during a pre-commit stall.
          // On commit the driver dedups the buffered message_start and — for `empty_text` (anchorBlockOpen) —
          // closes the anchor off + remaps real blocks +1; for `enveloped_ping` (no block) it only dedups.
          // Undefined for `ping` → every anchor branch in the driver is inert.
          anchor: anchorHooks,
          anchorState,
          sawMessageStop: () => acc.sawMessageStop,
          // H2 (a terminal upstream `error` frame) is a clean drain WITHOUT message_stop — the same
          // shape as an RST-truncation. This lets the buffered sink COMMIT it (the handler then fails
          // via acc.streamError, mirroring live) instead of wastefully retrying it as a truncation.
          sawUpstreamError: () => acc.streamError !== undefined,
          onAttemptReset,
          retryCap: state.protectStreamingMaxRetries,
          bufferCapBytes: state.protectStreamingBufferCapBytes,
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
          // L2 hit-rate telemetry (RFC §10): aggregate counter (→ /api/status.protect_streaming) +
          // a per-entry feature tag + an operator log line — recorded ONLY for an actual L2 engagement:
          // a save after ≥1 retry, an exhaustion, or a buffer-cap retreat. A clean first-try commit
          // (retries === 0, no RST) is the silent buffered happy path — tagging/counting it would put
          // `protect-streaming-retry` on essentially every 200 and inflate the "success" hit-rate with
          // requests L2 never actually engaged on.
          onBufferedResolve: (outcome, retries) => {
            if (outcome === "success" && retries === 0) return
            recordProtectStreamingOutcome(outcome, retries)
            env.ctx.recordFeature("protect-streaming-retry", { outcome, retries })
            consola.debug(`[protect-stream] ${outcome} for ${acc.model || model} after ${retries} retr${retries === 1 ? "y" : "ies"}`)
          },
        })
      : await driver.runResponseSink(upstream, env, liveReconcilingSink(sink, anchorHooks, anchorState), { onUpstreamFrame })

    recordForwarded() // before any ctx.settle (settle finalizes the entry); finally re-guards a throw
    // Flush the COMMITTED attempt's tool-input repair outcomes once (telemetry + feature tag + log).
    // Per-attempt outcomes were reset in onAttemptReset, so only the committed attempt's remain — the
    // counters reflect per-request outcomes, not the buffered-retry count. The unrepairable fail-gate
    // below reads the derived `unrepairableToolInput` (this does not clear it).
    flushToolInputRepairObservability(env.ctx)
    if (outcome.kind === "settled-abort") {
      // Client disconnected mid-stream — the stream is dead, write ZERO further bytes
      // (B0-d). Settle as aborted (forwarded snapshot guaranteed by the finally).
      consola.debug("[Stream] Client disconnected mid-stream — recording aborted")
      env.ctx.abort(acc.model || model, { usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens }, stop_reason: acc.stopReason || undefined })
      return
    }

    if (outcome.kind === "stream-error") {
      // H3 — the upstream iterable (or a sink write) threw a non-abort error. Synthesize the
      // Anthropic error frame + record it into the forwarded track (the client receives it, so
      // it belongs in `inboundResponse.sseEvents`), THEN settle. Ordering is load-bearing:
      // writeSynthetic samples the frame into `forwardedSseEvents`, recordForwarded snapshots it,
      // and only then does ctx.fail() freeze `inboundResponse` — a post-fail snapshot would miss it.
      const error = outcome.error
      logUpstreamStreamError(error, { model: acc.model || model, streamState, acc, sseEvents })
      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorType = anthropicStreamErrorType(error)
      // §10.5 gap (whole-branch review I-1): the live pump can stream-error BEFORE the first real
      // content_block_start (a delayed-commit stall injected the anchor, then the upstream body threw) —
      // reconcileLiveFrame never got to close the anchor, so it is still OPEN. Close it off (stop@0) BEFORE
      // the error frame or the client is left with a dangling block. Idempotent + inert (shared anchorClosed
      // guard): a no-op when reconcile already closed it, or when no anchor was injected.
      await closeAnchorIfOpen(sink, anchorHooks, anchorState)
      await sink
        .writeSynthetic?.({ event: "error", data: JSON.stringify({ type: "error", error: { type: errorType, message: errorMessage } }) })
        .catch(() => undefined)
      recordForwarded()
      // C1: preserve the partial content accumulated before the throw (mirrors the
      // truncation/refusal branches) so pre-abort thinking blocks aren't lost to null.
      const partial = buildAnthropicResponseData(acc, model)
      env.ctx.fail(acc.model || model, error, {
        usage: partial.usage,
        stop_reason: partial.stop_reason,
        content: partial.content,
      })
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
      // H2 — a terminal upstream `error` SSE event was forwarded as a content frame (clean
      // drain, never a thrown error → outcome is `complete`); settle as fail from the acc.
      consola.error(`[Stream] Upstream error for ${acc.model || model}: ${acc.streamError.type} — ${acc.streamError.message}`)
      // C1: preserve the partial content accumulated before the terminal error frame (mirrors
      // the truncation/refusal branches) so pre-abort thinking blocks aren't lost to null.
      const partial = buildAnthropicResponseData(acc, model)
      env.ctx.fail(acc.model || model, new Error(`${acc.streamError.type}: ${acc.streamError.message}`), {
        usage: partial.usage,
        stop_reason: partial.stop_reason,
        content: partial.content,
      })
    } else if (
      state.refusalSseRewrite === "error"
      && isThinkingOnlyRefusal(
        acc.stopReason,
        acc.contentBlocks.some((b) => b.type === "text" || b.type === "tool_use"),
      )
    ) {
      // Refusal -> error (error mode): the S5 rewrite layer already emitted the Anthropic `event: error`
      // frame (into the forwarded track, replacing the upstream terminator); the handler OWNS the
      // terminal state + observability here. Detected on the upstream-original accumulator (acc sees
      // pre-rewrite frames, so acc.stopReason is the genuine "refusal"); the judgment matches the
      // rewrite's (client-visible text/tool_use only -- server_tool_use excluded). MUST precede the
      // truncation branch: a refusal without message_stop would otherwise also hit !acc.sawMessageStop
      // and double-emit an error frame. No writeSynthetic (frame already on the wire + already sampled
      // into forwarded by the pre-branch recordForwarded). The upstream leg SUCCEEDED (delivered a
      // complete refusal response) — the proxy introduced the error verdict, so `upstreamSucceeded`
      // keeps outboundResponse honest (success:true) and routes the verdict to failureReason.
      const partial = buildAnthropicResponseData(acc, model)
      consola.error(`[REFUSAL] upstream thinking-only refusal for ${acc.model || model} -> recorded as error`)
      env.ctx.recordFeature("refusal-errored")
      env.ctx.fail(
        acc.model || model,
        new Error("upstream thinking-only refusal"),
        { usage: partial.usage, stop_reason: partial.stop_reason, content: partial.content },
        { upstreamSucceeded: true },
      )
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
        { usage: partial.usage, stop_reason: partial.stop_reason, content: partial.content },
        { upstreamSucceeded: true },
      )
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
      // §10.5 gap (I-1): the live pump can truncate (clean EOF, no message_stop) BEFORE the first real
      // content_block_start — a delayed-commit stall injected the anchor, then the upstream closed silently.
      // reconcile never closed the anchor, so close it off (stop@0) before the error frame. Idempotent (a
      // real first block already closed it → no-op) + inert (no anchor injected → byte-equivalent).
      await closeAnchorIfOpen(sink, anchorHooks, anchorState)
      await sink
        .writeSynthetic?.({
          event: "error",
          data: JSON.stringify({ type: "error", error: { type: "api_error", message: "Upstream stream truncated before completion (no message_stop)" } }),
        })
        .catch(() => undefined)
      recordForwarded()
      env.ctx.fail(acc.model || model, new Error("upstream stream truncated: closed without message_stop"), {
        usage: partial.usage,
        stop_reason: partial.stop_reason,
        content: partial.content,
      })
    } else {
      env.ctx.complete(buildAnthropicResponseData(acc, model))
    }
  } catch (error) {
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
 *   - settles from `codec.getStreamMeta()` (out-of-band terminal stop_reason + net usage): a clean drain
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
  const { sink, forwardedSseEvents, streamStartMs, driver, codec, upstream, env, anchorHooks, anchorState } = opts
  // The translate-leg env.body is the CC-canonical wire body (translateOut delegated to the hub), so it
  // carries the resolved model name; fall back to a literal when absent (defensive, never for a real leg).
  const model = (env.body as { model?: string }).model ?? "unknown"
  const targetEndpoint = env.targetEndpoint

  // OUTBOUND-leg (raw upstream) accumulator: cc leg → CC accumulator; responses leg → Responses
  // accumulator (feeds `outboundResponse` the honest upstream shape). Distinct from the client-facing
  // Anthropic frames the sink forwards + samples.
  const ccAcc = targetEndpoint === ENDPOINT.CHAT_COMPLETIONS ? createOpenAIStreamAccumulator() : undefined
  const respAcc = ccAcc ? undefined : createResponsesStreamAccumulator()

  const onUpstreamFrame = (frame: UpstreamFrame): void => {
    const rawEvent = frame as ServerSentEventMessage
    if (!rawEvent.data || rawEvent.data === "[DONE]") return
    try {
      const parsed = JSON.parse(rawEvent.data) as Record<string, unknown>
      if (ccAcc) accumulateOpenAIStreamEvent(parsed as never, ccAcc)
      else if (respAcc) accumulateResponsesStreamEvent(parsed as never, respAcc)
    } catch (error) {
      // A malformed upstream frame is logged, not fatal (parity with the direct pump / RFC §12.6).
      consola.error("[Anthropic:v4:translate] Failed to parse upstream stream event:", error, rawEvent.data)
    }
  }

  const recordForwarded = (): void => env.ctx.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })
  /** The OUTBOUND-leg ResponseData (honest upstream shape) for the terminal settle. */
  const outboundResponseData = (): ReturnType<typeof buildOpenAIResponseData> =>
    ccAcc ? buildOpenAIResponseData(ccAcc, model) : buildResponsesResponseData(respAcc as NonNullable<typeof respAcc>, model)

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
    const outcome = await driver.runResponseSink(upstream, env, clientSink, { onUpstreamFrame })

    if (outcome.kind === "settled-abort") {
      recordForwarded()
      consola.debug("[Anthropic:v4:translate] Client disconnected mid-stream — recording aborted")
      const meta = codec.getStreamMeta()
      env.ctx.abort(model, {
        usage: { input_tokens: meta?.usage.input_tokens ?? 0, output_tokens: meta?.usage.output_tokens ?? 0 },
        ...(meta?.stopReason && { stop_reason: meta.stopReason }),
      })
      return
    }

    if (outcome.kind === "stream-error") {
      // H3 — the upstream iterable (or a sink write) threw. Close any open anchor, write a synthetic
      // Anthropic error terminator, snapshot the forwarded track, THEN fail (order load-bearing — ctx.fail
      // freezes inboundResponse; a post-fail snapshot misses the error frame).
      const error = outcome.error
      logUpstreamStreamError(error, {
        model,
        streamState: { streamStartMs, bytesIn: 0, eventsIn: 0, currentBlockType: "", firstEventLogged: false, recoverFeatureLogged: false },
        acc: createAnthropicStreamAccumulator(),
        sseEvents: [],
      })
      await closeAnchorIfOpen(sink, anchorHooks, anchorState)
      await sink
        .writeSynthetic?.({
          event: "error",
          data: JSON.stringify({
            type: "error",
            error: { type: anthropicStreamErrorType(error), message: error instanceof Error ? error.message : String(error) },
          }),
        })
        .catch(() => undefined)
      recordForwarded()
      env.ctx.fail(model, error, outboundResponseData())
      return
    }

    // outcome.kind === "complete" — the upstream drained cleanly. The terminal stop_reason is the F2
    // signal: undefined ⇒ the CC/Responses stream ended with NO finish_reason ⇒ truncation.
    const meta = codec.getStreamMeta()
    if (meta?.stopReason === undefined) {
      // Truncation: forward the translator's block-close frames (partial content stays balanced) but DROP
      // its terminal message_delta/message_stop (they'd signal a clean completion), then write a synthetic
      // Anthropic error terminator + fail (mirrors the gemini truncation gate + the direct pump's). The
      // block-close frame goes through `clientSink` so its index is +1-remapped under an injected anchor.
      for (const frame of codec.flushResponse(env)) {
        if (!isMessageTerminatorFrame(frame)) await clientSink.write(frame)
      }
      await closeAnchorIfOpen(sink, anchorHooks, anchorState)
      await sink
        .writeSynthetic?.({
          event: "error",
          data: JSON.stringify({ type: "error", error: { type: "api_error", message: "Upstream stream truncated before completion (no finish_reason)" } }),
        })
        .catch(() => undefined)
      recordForwarded()
      consola.error(`[Anthropic:v4:translate] Upstream truncated for ${model}: drained without a finish_reason`)
      env.ctx.fail(model, new Error("upstream stream truncated: closed without finish_reason"), outboundResponseData())
      return
    }

    // Clean completion: drain the translator's terminal frames (the last block's content_block_stop +
    // message_delta + message_stop) through `clientSink` so the block-close is +1-remapped under an injected
    // anchor (message_delta / message_stop are index-less → passthrough), snapshot the forwarded track, then
    // settle complete with the OUTBOUND-leg (upstream) response data.
    for (const frame of codec.flushResponse(env)) await clientSink.write(frame)
    recordForwarded()
    env.ctx.complete(outboundResponseData())
  } catch (error) {
    // Unexpected throw from the driver/sink: synthesize an Anthropic error terminator + record it, THEN fail.
    await closeAnchorIfOpen(sink, anchorHooks, anchorState)
    await sink
      .writeSynthetic?.({
        event: "error",
        data: JSON.stringify({ type: "error", error: { type: "api_error", message: error instanceof Error ? error.message : String(error) } }),
      })
      .catch(() => undefined)
    recordForwarded()
    env.ctx.fail(model, error, outboundResponseData())
  } finally {
    recordForwarded()
  }
}
