/**
 * v4 pipeline — PipelineDriver (P2.1 skeleton).
 *
 * The data-flow driver: pushes a request through the seven stages (S1→S7),
 * publishing events / sampling raw data at the stage boundaries. Lifted+merged
 * from the current `executeRequestPipeline` retry loop and the handlers'
 * orchestration skeleton (docs/v4/01-architecture.md §1.3, 03-spec/envelope-driver.md §3).
 *
 * P2.1 builds the format-agnostic skeleton; it consumes a {@link FormatCodec} +
 * {@link Transport} + retry strategies + the rewrite registry as opaque deps, so
 * the unit tests drive it with a mock codec/transport. No format is wired here —
 * the codecs (P2.2–P2.6) and route switches (P2.3+) come later.
 */

import consola from "consola"

import type { SseEventRecord } from "~/lib/history"

import { classifyError } from "~/lib/error"
import { classifyStreamError } from "~/lib/stream"

import type { RequestEnvelope } from "./envelope"
import type {
  //
  ClientFrame,
  ClientSink,
  DriverRequestResult,
  FormatCodec,
  PipelineDriver,
  RawHttpRequest,
  RequestInspectStage,
  RequestInspection,
  ResponseOutcome,
  RetryAction,
  RetryStrategy,
  RunBufferedOpts,
  RunResponseOpts,
  Transport,
  UpstreamFrame,
  UpstreamStream,
} from "./types"

import {
  //
  assembleRequestRewrites,
  assembleResponseRewrites,
  BUILTIN_REQUEST_REWRITES,
  BUILTIN_RESPONSE_REWRITES,
  type FrameAction,
  type RequestRewrite,
  type ResponseRewrite,
  type RewriteState,
} from "./rewrite-registry"

/**
 * Everything the driver needs to orchestrate one format. The route layer (P2.3+)
 * selects the codec by prefix and constructs a driver per request.
 */
export interface DriverDeps {
  codec: FormatCodec
  transport: Transport
  /**
   * Ordered retry strategies (first `canHandle` wins — 02 §1.2 order semantics).
   * Either a fixed array, or a per-request factory resolved with the parsed
   * envelope (S4 input) — strategies that need parse outputs (e.g. the model,
   * or the codec's truncation baseline) use the factory form.
   */
  strategies: ReadonlyArray<RetryStrategy> | ((env: RequestEnvelope) => ReadonlyArray<RetryStrategy>)
  /** Normal-budget retry cap (pipeline.ts default 3). */
  maxRetries: number
  /** Learning-budget retry cap (pipeline.ts MAX_LEARNING_RETRIES=32). */
  maxLearningRetries: number
  /** S3 request rewrites (codecs supply format rewrites; default = module registry). */
  requestRewrites?: ReadonlyArray<RequestRewrite>
  /** S5 response rewrites (codecs supply format rewrites; default = module registry). */
  responseRewrites?: ReadonlyArray<ResponseRewrite>
  /**
   * Post-gate per-retry meta sink (C0-② / RFC §11.2). The driver invokes it with
   * the `RetryAction.meta` of a retry **only after the budget gate accepts it**,
   * so a budget-rejected retry never emits phantom pipeline-info. The handler
   * routes the format-specific meta fields (CC `truncateResult`; Anthropic
   * `sanitization` / `strippedBetas` / `probedBetas` / `truncateResult`) to its
   * observability sinks. `env` is the post-retry env carrying that meta.
   */
  onMeta?: (meta: Record<string, unknown>, env: RequestEnvelope) => void
}

/** The driver with its non-streaming response variant (envelope-driver.md §3). */
export interface PipelineDriverWithNonStreaming extends PipelineDriver {
  /** S5→S6 non-streaming: render the whole upstream response back to the client. */
  runResponseNonStreaming(upstream: UpstreamStream, env: RequestEnvelope): unknown
  /**
   * S5 non-streaming (design §3.1, A.B): apply each rewrite's `transformWhole` to the
   * already-rendered whole response, in the SAME ascending-`order` chain as the per-frame
   * `runResponse`. Pure (no observability / ctx settling — the handler owns that); the caller
   * passes the rendered response (from `runResponseNonStreaming`) and gets the rewritten one.
   */
  runResponseWhole(response: unknown, env: RequestEnvelope): unknown
  /**
   * owns-the-sink streaming response (Stage B B1, design §3.2). The driver drives the
   * S5→S6 chain and writes each client frame to `sink`, returning a format-agnostic
   * {@link ResponseOutcome} (NO accumulator — the handler keeps its own). B1 is a thin
   * wrapping shim over the generator `runResponse` (additive, NO consumer yet — every
   * handler still drives the generator); B2–B5 cut formats over and refine the outcome.
   */
  runResponseSink(upstream: UpstreamStream, env: RequestEnvelope, sink: ClientSink, opts?: RunResponseOpts): Promise<ResponseOutcome>
  /**
   * L2 — transactional buffered retry (docs/rfc/streaming-upstream-rst-buffered-retry.md).
   * Buffers each attempt's rendered frames instead of writing them live; commits (flushes to
   * `sink`) ONLY on a clean drain that saw `message_stop`; on a transport-close RST (or a
   * truncation = clean drain without message_stop) re-runs the exchange for a fresh stream and
   * re-buffers, up to `opts.retryCap`. All-or-nothing: a partially-generated response is never
   * forwarded (the client gets ONE complete generation, or the surfaced error). Default OFF
   * (Phase 1: no consumer — every handler still uses `runResponseSink`).
   */
  runResponseBufferedSink(upstream: UpstreamStream, env: RequestEnvelope, sink: ClientSink, opts: RunBufferedOpts): Promise<ResponseOutcome>
}

export function createPipelineDriver(deps: DriverDeps): PipelineDriverWithNonStreaming {
  return {
    runRequest: (raw) => runRequest(deps, raw),
    runResponse: (upstream, env, opts) => runResponse(deps, upstream, env, opts),
    inspectRequest: (raw, stopAfter) => inspectRequest(deps, raw, stopAfter),
    runResponseNonStreaming: (upstream, env) => deps.codec.renderResponseNonStreaming(upstream.nonStream, env),
    runResponseWhole: (response, env) => runResponseWhole(deps, response, env),
    runResponseSink: (upstream, env, sink, opts) => runResponseSink(deps, upstream, env, sink, opts),
    runResponseBufferedSink: (upstream, env, sink, opts) => runResponseBufferedSink(deps, upstream, env, sink, opts),
  }
}

// ============================================================================
// Request side (S1→S4)
// ============================================================================

/** S1→S4: ingest → route/translate → rewrite-in → exchange (error-driven retry). */
async function runRequest(deps: DriverDeps, raw: RawHttpRequest): Promise<DriverRequestResult> {
  // S1 — Ingest: parse inbound → envelope (codec builds ctx + extracts body/model).
  const parsed = deps.codec.parse(raw)

  // S2 — Translate-in: decideRoute (passthrough / translate / reject) + translateOut.
  const decision = deps.codec.decideRoute(parsed)
  if (decision.kind === "reject") {
    // No dangling history entry — reject before committing the request (aligns
    // with current messages:165 rejecting before context creation). Carry the
    // raw reason; the route/codec shapes the per-format error envelope.
    return { ok: false, rejection: { status: decision.status, reason: decision.reason, format: parsed.clientFormat } }
  }
  const targetEndpoint = decision.kind === "passthrough" ? decision.endpoint : decision.to
  const routed = deps.codec.translateOut(parsed.with({ targetEndpoint }))

  // S3 — Rewrite-in: assemble + run the request-rewrite chain.
  const rewritten = runRewriteIn(deps, routed)

  // S4 — Exchange: error-driven retry loop (prepareWire → transport → strategy re-env).
  // Resolve the strategy factory now that the envelope (model + codec state) exists.
  const strategies = typeof deps.strategies === "function" ? deps.strategies(rewritten) : deps.strategies
  // C0-① (RFC §11.1): runExchange returns the POST-retry env (the final attempt's
  // env), not `rewritten` (pre-exchange). Consumers — e.g. the Anthropic pump
  // building the tool-call recoverer from env.body.tools, which deferred-tool-retry
  // mutates — must see what was actually sent on the successful attempt.
  const { upstream, env: settled } = await runExchange(deps, rewritten, strategies)
  return { ok: true, upstream, env: settled }
}

/** S3: assemble the request-rewrite chain and apply each in declared order. */
function runRewriteIn(deps: DriverDeps, env: RequestEnvelope): RequestEnvelope {
  let current = env
  for (const rewrite of assembleRequestRewrites(current, deps.requestRewrites ?? BUILTIN_REQUEST_REWRITES)) {
    const result = rewrite.apply(current)
    current = result.env
    // P3.2 wires `request.rewrite_applied`{name, changed, stats} here.
  }
  return current
}

/** Deep-snapshot a stage's `body` so later stages' in-place mutation can't perturb earlier snapshots. */
function snapshotBody(body: unknown): unknown {
  try {
    return structuredClone(body)
  } catch {
    return body
  }
}

/**
 * Inspect S1→`stopAfter` WITHOUT entering S4 (RFC §4). Mirrors `runRequest`'s S1-S3 verbatim
 * (same codec calls + `runRewriteIn` logic) but snapshots each stage and stops early — the
 * driver stays the single authority on stage ordering (no duplicated chain in the endpoint).
 */
function inspectRequest(deps: DriverDeps, raw: RawHttpRequest, stopAfter: RequestInspectStage): RequestInspection {
  const stages: RequestInspection["stages"] = {}

  // S1 — parse.
  const parsed = deps.codec.parse(raw)
  stages.parse = { clientFormat: parsed.clientFormat, targetEndpoint: parsed.targetEndpoint, model: parsed.model, body: snapshotBody(parsed.body) }
  if (stopAfter === "parse") return { stoppedAt: "parse", stages }

  // S2 — route / translate.
  const decision = deps.codec.decideRoute(parsed)
  if (decision.kind === "reject") return { stoppedAt: "reject", rejected: { status: decision.status, reason: decision.reason }, stages }
  const targetEndpoint = decision.kind === "passthrough" ? decision.endpoint : decision.to
  const routed = deps.codec.translateOut(parsed.with({ targetEndpoint }))
  stages.translate = { targetEndpoint: routed.targetEndpoint, body: snapshotBody(routed.body) }
  if (stopAfter === "translate") return { stoppedAt: "translate", stages }

  // S3 — rewrite-in (mirror runRewriteIn, capturing per-rewrite {name, changed}).
  const applied: Array<{ name: string; changed: boolean }> = []
  let current = routed
  for (const rewrite of assembleRequestRewrites(current, deps.requestRewrites ?? BUILTIN_REQUEST_REWRITES)) {
    const result = rewrite.apply(current)
    applied.push({ name: rewrite.name, changed: result.changed })
    current = result.env
  }
  stages["rewrite-in"] = { body: snapshotBody(current.body), applied }
  if (stopAfter === "rewrite-in") return { stoppedAt: "rewrite-in", stages }

  // S4-pre — prepare-wire: the codec's last-mile wire derivation for the FIRST attempt
  // (RFC §4 / §11 P1). NEVER enters the exchange loop, so reactive retry rewrites
  // (beta-strip / server-tool-strip — only triggered by an upstream error) are invisible;
  // `note` flags that. `prepareWire` is non-pure in real codecs (betaProbe.recordOutbound /
  // ctx.recordFeature) — the caller isolates those side effects (throwaway probe + capturing ctx).
  const wire = deps.codec.prepareWire(current)
  stages["prepare-wire"] = {
    url: wire.url,
    headers: Object.fromEntries(wire.headers.entries()),
    body: snapshotBody(wire.body),
    stream: wire.stream,
    note: "first-attempt only; reactive retry rewrites (beta-strip / server-tool-strip) not visible",
  }
  return { stoppedAt: "prepare-wire", stages }
}

/**
 * S4: the error-driven retry loop (docs/v4/03-spec/retry-transport.md §2). Each
 * attempt re-derives the wire from env via `codec.prepareWire`; a failure runs
 * the first matching strategy, which returns a modified env, and the next turn
 * re-prepares from it. The adaptive rate-limiter (429) lives inside
 * `transport.send`, below this loop — it never bubbles up here.
 */
async function runExchange(
  deps: DriverDeps,
  env: RequestEnvelope,
  strategies: ReadonlyArray<RetryStrategy>,
): Promise<{ upstream: UpstreamStream; env: RequestEnvelope }> {
  let current = env
  let normalRetries = 0
  let learningRetries = 0
  let activeStrategy: RetryStrategy | undefined
  // The accepted retry's meta (post-gate), threaded to onMeta + onResolved (C0-②).
  let activeMeta: Record<string, unknown> | undefined

  for (;;) {
    const wire = deps.codec.prepareWire(current)
    current.ctx.beginAttempt({ ...(activeStrategy && { strategy: activeStrategy.name }) })
    // S4 per-attempt sampling (P2.3-S): the codec derives the history effective +
    // wire request descriptors from the prepared wire + env (format-specific). The
    // attempt record exists (beginAttempt above); record both tracks on it.
    const sample = deps.codec.sampleRequest?.(wire, current)
    if (sample) {
      current.ctx.setAttemptEffectiveRequest(sample.effective)
      current.ctx.setAttemptWireRequest(sample.wire)
    }
    current.ctx.transition("executing")
    try {
      const upstream = await deps.transport.send(wire, current)
      // RFC history-http-header-capture Phase 2: driver owns the outbound header
      // capture (no handler-side HeadersCapture bag). ② outboundRequest = the wire
      // headers in hand; ③ outboundResponse = the upstream response headers carried
      // by UpstreamStream.headers (empty for the upstream-WS path → leg omitted).
      // Written per-attempt via the merge setter → the FINAL attempt's values stick
      // at the top-level legs; Phase 3 ALSO records them per-attempt (setAttempt*).
      const upstreamRespHeaders = Object.fromEntries(upstream.headers.entries())
      const wireReqHeaders = Object.fromEntries(wire.headers.entries())
      current.ctx.setHttpHeaders({
        request: wireReqHeaders,
        ...(Object.keys(upstreamRespHeaders).length > 0 && { response: upstreamRespHeaders }),
      })
      if (Object.keys(upstreamRespHeaders).length > 0) current.ctx.setAttemptResponseHeaders(upstreamRespHeaders)
      // onResolved threads the post-gate meta of the retry that produced this env
      // (C0-② / RFC §11.2) so the owning strategy commits its learning from it
      // (e.g. unsupported-beta fixates meta.probedBetas). undefined on first-attempt
      // success (no retry produced this env).
      await activeStrategy?.onResolved?.(current, activeMeta)
      // C0-① (RFC §11.1): return the POST-retry env (the final attempt's `current`),
      // not the caller's pre-exchange env — consumers read what was actually sent.
      return { upstream, env: current }
    } catch (error) {
      const apiError = classifyError(error)
      current.ctx.setAttemptError(apiError)
      // RFC Phase 2: capture the outbound legs on the failure path too. ② from the
      // wire; ③ from apiError.responseHeaders (classifyHTTPError now passes it through
      // on ALL HTTP-error branches). Network/abort failures have no upstream response
      // → response leg correctly absent. Final attempt wins at the top level.
      current.ctx.setHttpHeaders({
        request: Object.fromEntries(wire.headers.entries()),
        ...(apiError.responseHeaders && { response: Object.fromEntries(apiError.responseHeaders.entries()) }),
      })
      if (apiError.responseHeaders) current.ctx.setAttemptResponseHeaders(Object.fromEntries(apiError.responseHeaders.entries()))

      const strategy = strategies.find((s) => s.canHandle(apiError))
      if (!strategy) throw error // no strategy → [FAIL]

      // A strategy that itself throws degrades to failing the request with the
      // ORIGINAL caught error (legacy parity — pipeline.ts:307-314 warns + breaks
      // + re-throws the original error rather than the strategy's own failure).
      let action: RetryAction
      try {
        action = await strategy.handle(apiError, current)
      } catch (strategyError) {
        consola.warn(
          `[Driver] Strategy "${strategy.name}" threw while handling the error:`,
          strategyError instanceof Error ? strategyError.message : strategyError,
        )
        throw error
      }
      // Abort → surface the ORIGINAL caught error (a proper Error/HTTPError with
      // stack), matching the legacy pipeline (which breaks the loop and re-throws
      // the original error, pipeline.ts:312). `apiError` (the classified form) is
      // already recorded via setAttemptError; `action.error` reserves a future
      // strategy-supplied override but is not surfaced here (the spec draft's
      // `throw action.error` would throw a non-Error ApiError, losing the stack).
      if (action.kind === "abort") throw error

      // Budget gate (normal vs learning) — after handle, mirroring pipeline.ts.
      const overBudget = action.learning ? learningRetries++ >= deps.maxLearningRetries : normalRetries++ >= deps.maxRetries
      if (overBudget) throw error

      current = action.env
      activeStrategy = strategy
      // Capture the accepted retry's meta post-gate (C0-② / RFC §11.2): a
      // budget-rejected retry threw above (over-budget → throw), so its meta never
      // reaches here. Route it to the handler's observability sink (only when
      // present) and remember it for this strategy's onResolved.
      activeMeta = action.meta
      if (action.meta) deps.onMeta?.(action.meta, current)
      current.ctx.recordAttemptFailure({
        willRetry: true,
        nextStrategy: strategy.name,
        ...(action.waitMs !== undefined && { waitMs: action.waitMs }),
        ...(action.learning && { learning: action.learning }),
      })
      // Count the retry backoff in queueWaitMs (legacy parity — pipeline.ts adds
      // action.waitMs to queueWaitMs in addition to the rate-limiter wait).
      if (action.waitMs) {
        current.ctx.addQueueWaitMs(action.waitMs)
        await delay(action.waitMs)
      }
    }
  }
}

// ============================================================================
// Response side (S5→S7)
// ============================================================================

/** S5→S7: rewrite-out (per-frame chain + flush) → renderResponse → yield. */
async function* runResponse(deps: DriverDeps, upstream: UpstreamStream, env: RequestEnvelope, opts?: RunResponseOpts): AsyncIterable<ClientFrame> {
  // S5 — Rewrite-out: assemble the response-rewrite chain (per-request state, seeded from env).
  const rewrites = assembleResponseRewrites(env, deps.responseRewrites ?? BUILTIN_RESPONSE_REWRITES)
  const states: Array<RewriteState> = rewrites.map((r) => r.createState?.(env) ?? {})

  // S4-exit sampling (P3.2b, envelope-driver.md §4): record each upstream-ORIGINAL
  // frame (raw verbatim) BEFORE the rewrite/render chain. The `outboundResponse`
  // track must capture the upstream bytes PRE-translation — CC via-responses /
  // Responses fallback `renderResponse` is NOT identity (only Anthropic/direct
  // is), so the yield point is the wrong place for the upstream track. Universal
  // across every format that drives runResponse (CC / Responses / Gemini / Anthropic
  // HTTP + client WS), closing the "sseEvents recorded only on Anthropic" gap (§4
  // "关键改进", D8 原始记录完整性). `frame.event` is the SSE event type — for
  // Anthropic it equals the `parsed.type` the legacy pump recorded (Anthropic always
  // sends an event line), so this stays byte-equivalent there; the fallback only
  // applies to formats whose chunks carry no event line (CC).
  //
  // Pushed per-frame and aliased onto ctx on the first frame (setSseEvents stores
  // the array reference): a consumer that breaks early (the Anthropic pump breaks
  // on [DONE]/error) abandons this generator, so code AFTER the loop never runs —
  // but the aliased array already holds every frame consumed up to the break.
  const upstreamSse: Array<SseEventRecord> = []
  const streamStartMs = Date.now()
  // T2 (dry-run): the upstream-frame ordinal threaded to `onRewriteAction`. Increments
  // per upstream frame iterated (the sampler closure reads the live value).
  let frameIndex = 0
  const onRewriteAction = opts?.onRewriteAction
  const sampleAction = onRewriteAction ? (name: string, action: FrameAction) => onRewriteAction(name, frameIndex, action) : undefined

  try {
    for await (const frame of upstream.frames) {
      // Skip the `[DONE]` sentinel — it's a gateway-injected transport terminator
      // (OpenAI convention, NOT part of the Anthropic protocol; anthropic/stream.ts:104),
      // not a content frame. The accumulators skip it and the legacy Anthropic pump
      // broke before recording it, so excluding it keeps the upstream-original track to
      // real content frames (no mislabeled `type:"message"` sentinel) + matches the
      // pre-P3.2b Anthropic baseline. Forwarded never carried it either (pump breaks).
      if (frame.data !== "[DONE]") {
        upstreamSse.push({ offsetMs: Date.now() - streamStartMs, type: frame.event ?? (frame.data ? "message" : "keepalive"), raw: frame.data ?? "" })
        if (upstreamSse.length === 1) env.ctx.setSseEvents(upstreamSse)
        // Hand the raw upstream frame to the handler's upstream-side work (accumulate
        // → outboundResponse, repetition, progress, diagnostics) BEFORE the rewrite
        // chain (RFC §4.A1 — keeps those on the upstream-original, not the rewritten
        // frames the loop yields below). Same skip-[DONE] condition as upstreamSse.
        opts?.onUpstreamFrame?.(frame)
      }
      // S5: thread the upstream frame through the rewrite chain (emit/suppress/buffer).
      for (const rewritten of passThrough([frame], rewrites, states, 0, sampleAction)) {
        // S6 — Translate-out: render the (target-endpoint) frame to the client protocol.
        // skipRender (dry-run T1) yields the S5 frame verbatim — the consumer wants the
        // rewrite-chain output BEFORE the S6 render translation.
        if (opts?.skipRender) yield rewritten
        else yield* renderFrames(deps, rewritten, env)
      }
      frameIndex++
    }
  } finally {
    // S5 flush: drain buffered frames at stream end. In `finally` (RFC §4.0.5, H3
    // pre-step) so `flushChain` RUNS on every generator exit — normal completion, an
    // upstream throw, AND a consumer-triggered `.return()` (`break`) / `.throw()`.
    //
    // Frame DELIVERY differs by exit, though (ECMAScript IteratorClose):
    //   - normal completion / upstream throw → the `yield*` below delivers flushed
    //     frames to the consumer (on a throw, BEFORE the error re-propagates — the
    //     generator unwinds through finally), so nothing is dropped.
    //   - consumer `break` → `.return()` → the finally still RUNS (buffer state /
    //     side effects clear), but IteratorClose DISCARDS values yielded here, so a
    //     breaking consumer does NOT receive them.
    //
    // With `BUILTIN_RESPONSE_REWRITES` empty this is a no-op (flushChain → []), so it is
    // behavior-preserving today — the live Anthropic pump always `break`s on
    // [DONE]/error and is unaffected. Phase 4 (migrating a buffering decode/recover
    // rewrite into the registry) MUST NOT rely on this finally to deliver flushed
    // frames to an early-breaking consumer — that path needs an explicit flush
    // before the break (cf. the handler's post-loop flush, handler-v4.ts:655-663).
    for (const flushed of flushChain(rewrites, states)) {
      if (opts?.skipRender) yield flushed
      else yield* renderFrames(deps, flushed, env)
    }
  }
}

/**
 * owns-the-sink streaming (Stage B, design §3.2): drain the generator `runResponse`
 * into `sink`, returning a control-signal {@link ResponseOutcome}. Reuses the
 * generator's S5→S6 chain verbatim, so the SINK FRAME SEQUENCE == the generator's
 * YIELD SEQUENCE (the B0 real-renderer goldens lock this byte-for-byte). `opts.onRenderedFrame`
 * (when supplied) transforms each rendered frame just before write — the forwarded-side
 * counterpart to `opts.onUpstreamFrame` (CC/Responses tool-name restore + accumulate; Anthropic
 * omits it). `opts.stopAfterFrame` (when supplied) breaks the drain loop after a terminal frame
 * and settles `complete` (Responses WS stops after `response.completed`). `sink.close()` runs on
 * EVERY exit (normal / break / throw / abort / write-reject) so the heartbeat timer can't leak.
 *
 * `[DONE]` handling: the generator YIELDS the `[DONE]` sentinel (guard only blocks
 * sampling); `runResponseSink` DROPS it (it's a gateway transport terminator, NOT a
 * content frame — anthropic/stream.ts:104) so it never reaches a sink. The per-format
 * trailing terminator is the handler's job (Anthropic emits NONE; CC/Responses
 * synthesize their own `data: [DONE]` post-loop).
 *
 * Terminal classification (B3a — refining B1's single `stream-error`):
 *   - clean drain → `complete{headers}` (a terminal upstream `error` frame, H2, is a
 *     clean drain — the handler reads its own `acc.streamError` to fail).
 *   - a thrown error classified `client-abort` → `settled-abort` (client gone, zero bytes).
 *   - any other throw (upstream blow-up H3, or a `sink.write` reject = client gone
 *     mid-write) → `stream-error` carrying the RAW error so the format handler classifies /
 *     formats / logs / settles it with full fidelity (richest-data-flow — the driver is
 *     format-agnostic and must not lossily pre-summarize).
 */
async function runResponseSink(
  deps: DriverDeps,
  upstream: UpstreamStream,
  env: RequestEnvelope,
  sink: ClientSink,
  opts?: RunResponseOpts,
): Promise<ResponseOutcome> {
  try {
    for await (const frame of runResponse(deps, upstream, env, opts)) {
      // Drop the `[DONE]` transport sentinel — never written to a sink (the format's
      // handler synthesizes its own trailing terminator; Anthropic emits none).
      if (frame.data === "[DONE]") continue
      // Post-render, pre-write transform (CC/Responses tool-name restore + accumulate/progress
      // side effects); identity when the format doesn't supply one (Anthropic). Applied AFTER
      // the `[DONE]` drop so the hook never sees the sentinel. A `undefined` return SKIPS the
      // frame (Responses drops empty/unparseable frames the legacy loop never forwarded).
      const toWrite = opts?.onRenderedFrame ? opts.onRenderedFrame(frame) : frame
      if (toWrite) {
        await sink.write(toWrite)
        // Early-stop after a terminal frame (Responses WS: don't read past response.completed —
        // a trailing frame or a stalled upstream would otherwise hang to idle-timeout). The break
        // runs the generator's `finally` (flushChain); empty for Responses, so nothing is lost.
        if (opts?.stopAfterFrame?.(toWrite)) break
      }
    }
    return { kind: "complete", headers: upstream.headers }
  } catch (error) {
    // A client disconnect (the transport guard's StreamClientAbortError, or any error
    // classified client-abort) settles as abort — the handler writes nothing further.
    if (classifyStreamError(error) === "client-abort") return { kind: "settled-abort" }
    // Otherwise surface the RAW error (richest-data-flow): the format handler classifies
    // it, shapes its protocol error frame, logs diagnostics, and settles ctx.fail.
    return { kind: "stream-error", error }
  } finally {
    sink.close?.()
  }
}

/**
 * L2 — transactional buffered retry (design §3, docs/rfc/streaming-upstream-rst-buffered-retry.md).
 *
 * Buffers each attempt's rendered frames (does NOT write them live), then commits the WHOLE
 * buffer to `sink` ONLY when the attempt drained cleanly AND the handler's accumulator saw
 * `message_stop`. A transport-close RST (thrown, `classifyStreamError === "other"`) or a
 * truncation (clean drain WITHOUT message_stop — Bun delivers a clean RST as a normal `end`)
 * discards the buffer and re-runs `runExchange` for a fresh upstream stream, up to
 * `opts.retryCap`. All-or-nothing: the client only ever receives ONE complete generation's
 * frames, or — on exhaustion / a non-retryable error — the surfaced `stream-error` (the handler
 * writes its protocol error frame, as today). NEVER retries a `client-abort` (client gone) or a
 * `shutdown` / `idle-timeout` (only transport-close).
 *
 * Per-attempt isolation: `runResponse` re-instantiates the S5 rewrite-chain state on each call;
 * `opts.onAttemptReset` resets the handler's accumulators; `ctx.commitAttemptSseEvents()` snapshots
 * each attempt's upstream-original frames onto its attempt record (D1) before the next attempt's
 * `runResponse` resets the top-level slot via `ctx.resetSseEvents()`.
 */
async function runResponseBufferedSink(
  deps: DriverDeps,
  upstream: UpstreamStream,
  env: RequestEnvelope,
  sink: ClientSink,
  opts: RunBufferedOpts,
): Promise<ResponseOutcome> {
  const cap = opts.retryCap ?? 0
  const bufferCapBytes = opts.bufferCapBytes ?? 0
  const strategies = typeof deps.strategies === "function" ? deps.strategies(env) : deps.strategies
  let current = upstream
  let currentEnv = env
  let attempt = 0
  try {
    for (;;) {
      const buffer: Array<ClientFrame> = []
      let bufferedBytes = 0
      let retreated = false
      let thrown: unknown
      let drained = false
      try {
        for await (const frame of runResponse(deps, current, currentEnv, opts)) {
          if (frame.data === "[DONE]") continue
          const toWrite = opts.onRenderedFrame ? opts.onRenderedFrame(frame) : frame
          if (!toWrite) continue
          if (retreated) {
            // Buffer cap already exceeded → live write-through for the rest (no more buffering).
            await sink.write(toWrite)
            continue
          }
          buffer.push(toWrite)
          bufferedBytes += (toWrite.data?.length ?? 0) + (toWrite.event?.length ?? 0)
          if (bufferCapBytes > 0 && bufferedBytes > bufferCapBytes) {
            // OOM guard: abandon buffering, flush what we have, switch to live for the rest. The
            // response loses L2 protection (a live RST now fails) and is NOT retried (frames are
            // forwarded). Documented tradeoff (RFC §7 / §12 Q4) — pathological huge responses are rare.
            retreated = true
            opts.onRetreat?.()
            for (const f of buffer) await sink.write(f)
            buffer.length = 0
          }
        }
        drained = true
      } catch (error) {
        // Client gone → settle abort, write nothing further, never retry.
        if (classifyStreamError(error) === "client-abort") return { kind: "settled-abort" }
        thrown = error
      }

      // Retreated to live: the frames are already forwarded — NO retry is possible (can't unsend).
      // The outcome mirrors the live path: complete (handler decides success/fail via its acc) or
      // stream-error (the throw / truncation surfaces as today).
      if (retreated) {
        opts.onBufferedResolve?.("retreated", attempt)
        if (drained) return { kind: "complete", headers: current.headers }
        return { kind: "stream-error", error: thrown ?? new Error("upstream stream truncated: closed without message_stop") }
      }

      // COMMIT on a clean drain that reached a TERMINAL upstream state: `message_stop` (success)
      // OR an upstream `error` frame (H2 — a terminal upstream decision such as overload, NOT a
      // transport cut). A clean drain with NEITHER is a truncation (Bun delivers a clean RST as a
      // normal `end`, rstCode=0, undetectable — transport/http2-client.ts:169-175) → retryable.
      // Committing H2 flushes the buffered upstream error frame to the client and lets the handler
      // fail via `acc.streamError`, exactly mirroring the live path (NOT a wasteful retry that would
      // also relabel the real error as "truncated" on exhaustion). The committing attempt's frames
      // live at the top-level slot, so they are NOT snapshotted per-attempt here — only a FAILED
      // (retried) attempt gets a per-attempt `sseEvents` row (D1), set in the retry branch below.
      if (drained && (opts.sawMessageStop() || opts.sawUpstreamError?.())) {
        try {
          for (const frame of buffer) await sink.write(frame)
        } catch (error) {
          // Client gone mid-flush (a `sink.write` reject) — map it like the drain path so the
          // buffered sink ALWAYS returns a ResponseOutcome, never a raw throw (mirrors
          // runResponseSink's catch; the buffer is discarded — the client got a partial flush).
          if (classifyStreamError(error) === "client-abort") return { kind: "settled-abort" }
          // L2 produced a COMPLETE generation (reached the terminal frame) — the flush failed at the
          // transport, NOT the retry: count it as a `success` so the hit-rate denominator isn't a
          // blind spot. The handler still settles the request as failed (delivery), independently.
          opts.onBufferedResolve?.("success", attempt)
          return { kind: "stream-error", error }
        }
        opts.onBufferedResolve?.("success", attempt)
        return { kind: "complete", headers: current.headers }
      }

      // Failure: a transport-close throw, OR a clean drain WITHOUT a terminal frame (truncation).
      // Retry ONLY a transport-close throw (`"other"`) or a truncation (no throw) — never a
      // shutdown / idle-timeout throw.
      const retryable = thrown ? classifyStreamError(thrown) === "other" : true
      if (retryable && attempt < cap) {
        attempt++
        // D1: snapshot THIS failed attempt's upstream-original frames onto the attempt BEFORE the
        // reset clears the top-level slot — so a failed attempt's frames survive for diagnosis.
        // (The final attempt — success-commit above OR exhaustion-return below — keeps its frames
        // at the top-level slot only, matching `extractStagePayloads`' finalIdx skip: no dup.)
        currentEnv.ctx.commitAttemptSseEvents()
        opts.onAttemptReset?.()
        currentEnv.ctx.resetSseEvents()
        // L2 escalation (RFC §8): let the caller tighten this retry's env (e.g. force aggressive
        // context_management) so the regenerated response is smaller/faster. Format-agnostic — the
        // driver just threads the returned env into the next exchange.
        if (opts.escalate) currentEnv = opts.escalate(currentEnv, attempt)
        const re = await runExchange(deps, currentEnv, strategies)
        current = re.upstream
        currentEnv = re.env
        continue
      }
      // Exhausted / non-retryable → surface the error (truncation synthesizes one) for the
      // handler to classify + write its protocol error frame (unchanged from the live path). The
      // final failed attempt's frames stay at the top-level slot (no per-attempt snapshot).
      opts.onBufferedResolve?.("exhausted", attempt)
      return { kind: "stream-error", error: thrown ?? new Error("upstream stream truncated: closed without message_stop") }
    }
  } finally {
    sink.close?.()
  }
}

/**
 * S5 non-streaming (design §3.1, A.B): apply each applicable rewrite's `transformWhole` to
 * the rendered whole response in ascending `order` (same chain order as the per-frame
 * `runResponse`). `assembleResponseRewrites` filters by `appliesTo` + sorts by `order`, so a
 * rewrite whose gate is off is skipped (= byte-identical to its helper's passthrough). No
 * per-rewrite state (whole-response helpers are stateless); `transformWhole`-less rewrites
 * (e.g. thinking-signature-compat) are no-ops here.
 */
function runResponseWhole(deps: DriverDeps, response: unknown, env: RequestEnvelope): unknown {
  let current = response
  for (const rewrite of assembleResponseRewrites(env, deps.responseRewrites ?? BUILTIN_RESPONSE_REWRITES)) {
    if (rewrite.transformWhole) current = rewrite.transformWhole(current, env)
  }
  return current
}

/** S6 + S7: render one upstream frame to client frame(s) and surface them. */
function* renderFrames(deps: DriverDeps, frame: UpstreamFrame, env: RequestEnvelope): Generator<ClientFrame> {
  const rendered = deps.codec.renderResponse(frame, env)
  const frames = Array.isArray(rendered) ? rendered : [rendered]
  for (const out of frames) {
    // Forwarded-frame (`inboundResponse`) sampling stays handler-side (P3.2b /
    // Option B): the TRUE client bytes are produced where the handler transforms
    // (tool-name restore, fix-stream-ids, CC→Gemini whole-stream translation) and
    // injects (verbose marker, via-responses [DONE], idle heartbeat). Two of those
    // — Gemini's whole-stream translator (P2.5-D1) and Anthropic's timer-driven
    // heartbeat (P1.5-OQ1) — do not flow through this yield point and cannot be
    // expressed as per-frame rewrites, so the driver cannot own forwarded sampling
    // without reintroducing the byte-critical risk those decisions deferred.
    yield out
  }
}

/**
 * Thread frames through `rewrites[startIdx..]` in order. Each rewrite's
 * `transform` may emit 0+ frames (fed to the next rewrite), suppress, or buffer
 * (held in its own state, drained at flush). Returns the frames surviving the
 * whole sub-chain.
 */
function passThrough(
  frames: Array<UpstreamFrame>,
  rewrites: ReadonlyArray<ResponseRewrite>,
  states: Array<RewriteState>,
  startIdx: number,
  sample?: (rewriteName: string, action: FrameAction) => void,
): Array<UpstreamFrame> {
  let current = frames
  for (let i = startIdx; i < rewrites.length; i++) {
    const next: Array<UpstreamFrame> = []
    for (const frame of current) {
      const action = rewrites[i].transform(frame, states[i])
      sample?.(rewrites[i].name, action)
      if (action.kind === "emit") next.push(...action.frames)
      // suppress / buffer → emit nothing now (buffer is held in the rewrite's state)
    }
    current = next
  }
  return current
}

/**
 * Drain each rewrite's flush in ASCENDING order; each flushed frame threads the
 * rewrites AFTER it (`passThrough` startIdx = `i + 1`). This is a deterministic
 * multi-buffer cascade (§4.A1 — resolves the P2.1-M2 "single buffer" assumption),
 * locked by tests/pipeline/response-rewrite-contract.unit.test.ts:
 *
 *   for i in 0..n: rewrites[i].flush() → passThrough(flushed, rewrites, states, i+1)
 *
 * So an earlier buffer's flushed frames are re-threaded through every later rewrite
 * — including a later BUFFERING rewrite, which may itself buffer them and release
 * them at ITS flush turn. Concretely for recover-tool-call(100) + tool-input-decode(200):
 * recover.flush → decode.transform (may buffer) → … → decode.flush drains them
 * (= handler-v4.ts:655-663's two-pass stream-end flush). Ordering is fully defined:
 * frames released by rewrite[i] always precede frames released by rewrite[j] for j > i.
 */
function flushChain(rewrites: ReadonlyArray<ResponseRewrite>, states: Array<RewriteState>): Array<UpstreamFrame> {
  const out: Array<UpstreamFrame> = []
  for (let i = 0; i < rewrites.length; i++) {
    const flushed = rewrites[i].flush?.(states[i]) ?? []
    if (flushed.length > 0) out.push(...passThrough(flushed, rewrites, states, i + 1))
  }
  return out
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
