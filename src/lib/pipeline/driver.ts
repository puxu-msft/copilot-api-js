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
import { readSyntheticKind } from "~/lib/pipeline/frame-origin"
import { getUpstreamHook } from "~/lib/pipeline/hooks/loader"
import {
  //
  readOrigin,
  tagFrameRewritten,
} from "~/lib/pipeline/hooks/origin"
import { getShutdownSignal } from "~/lib/shutdown"
import {
  //
  classifyStreamError,
  combineAbortSignals,
} from "~/lib/stream"
import {
  //
  abortableDelay,
  OperationCancelledError,
} from "~/lib/util/abortable-delay"

import type { RequestEnvelope } from "./envelope"
import type {
  //
  ClientFrame,
  ClientSink,
  DriverRequestResult,
  FormatCodec,
  PipelineDriver,
  PreparedRequest,
  RawHttpRequest,
  RequestInspectStage,
  RequestInspection,
  ResponseOutcome,
  RetryAction,
  RetryStrategy,
  RouteDecision,
  RunBufferedOpts,
  RunResponseOpts,
  Transport,
  UpstreamFrame,
  UpstreamStream,
} from "./types"

import {
  //
  type CellAssembly,
  isCellMigrated,
  resolveCellAssembly,
} from "./cell-assembly"
import {
  //
  isFirstUpstreamContent,
  isUpstreamContentFrame,
} from "./request-timing"
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
import { decideRoute } from "./router"
/**
 * Everything the driver needs to orchestrate one format. The route layer (P2.3+)
 * selects the codec by prefix and constructs a driver per request.
 */
export interface DriverDeps {
  codec: FormatCodec
  transport: Transport
  /**
   * Ordered retry strategies for the LEGACY (non-migrated) path — a fixed array or a per-request factory.
   * OPTIONAL since C5: every real handler's cell is migrated, so its exchange stack comes from the
   * CellAssembly ({@link resolveExchangeStrategies}); this slot is only read for a mock/legacy codec that
   * does not populate `env.requestState` (driver orchestration unit tests).
   */
  strategies?: ReadonlyArray<RetryStrategy> | ((env: RequestEnvelope) => ReadonlyArray<RetryStrategy>)
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
  /**
   * S2 route decision override — a test seam (DI-consistent with `transport` / `strategies`).
   * Production omits it: the driver calls the free-function `router.decideRoute` (ADR
   * 2026-07-11), which reads real upstream model capabilities. Driver ORCHESTRATION unit
   * tests (which drive a mock codec through a fake model with no `state.modelIndex`) inject a
   * fixed decision here so they exercise stage sequencing without needing a live model index;
   * route-decision CORRECTNESS is covered by `tests/pipeline/router-golden.it.test.ts`, not the
   * orchestration tests. When omitted the driver uses the free-function `router.decideRoute`.
   */
  decideRoute?: (env: RequestEnvelope) => RouteDecision
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
   * L2 — transactional buffered retry (docs/archive/2606-landed-rfcs/streaming-upstream-rst-buffered-retry.md).
   * Buffers each attempt's rendered frames instead of writing them live; commits (flushes to
   * `sink`) ONLY on a clean drain that saw `message_stop`; on a transport-close RST (or a
   * truncation = clean drain without message_stop) re-runs the exchange for a fresh stream and
   * re-buffers, up to `opts.retryCap`. All-or-nothing: a partially-generated response is never
   * forwarded (the client gets ONE complete generation, or the surfaced error). The terminal is
   * format-agnostic via the `sawMessageStop` opt (Anthropic `message_stop`; Responses
   * `acc.status !== ""`). Opt-in per endpoint, default OFF: consumed by Anthropic
   * (`protect_streaming_generation`) and Responses (`responsesBufferedRetry`) — every other
   * handler still uses `runResponseSink`.
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

/**
 * S2 route decision. Prefers the `deps.decideRoute` test override; otherwise the
 * free-function `router.decideRoute` (ADR 2026-07-11), the single reader of upstream model
 * capabilities. Both driver call sites (`runRequest` S2, `inspectRequest` S2) go through
 * here so the routing seam is single-sourced.
 */
function resolveRouteDecision(deps: DriverDeps, parsed: RequestEnvelope): RouteDecision {
  return (deps.decideRoute ?? decideRoute)(parsed)
}

/**
 * The CellAssembly this env's cell is dispatched through, or `null` for the legacy `deps.*` path
 * (RFC 2026-07-13 §11.6 hybrid dispatch). CELL-keyed (clientFormat × targetEndpoint) so a partially
 * migrated leg — e.g. `/v1/messages`, shared by anthropic-direct (migrated, C2a) + 3 reverse cells
 * (legacy until C2b) — routes only the migrated cell through the assembly (no double-active). Resolved
 * from the CURRENT env at each dispatch point (a retry strategy may re-target).
 */
function migratedCell(env: RequestEnvelope): CellAssembly | null {
  // The assembly's methods REQUIRE the leg supply on `env.requestState` (the real InboundCodec's parse
  // populates it — C2a.1). An env without it is not set up for the cell (a driver orchestration unit test
  // with a mock codec, or a format whose parse hasn't populated it), so it stays on the legacy `deps.*`
  // path — the codec's own direct branch is still byte-equivalent, so this is a safe fallback.
  if (!env.requestState) return null
  return isCellMigrated(env.clientFormat, env.targetEndpoint) ? resolveCellAssembly(env.clientFormat, env.targetEndpoint) : null
}

/**
 * The exchange retry stack for this env: the MIGRATED cell's CellAssembly-composed stack, else the legacy
 * `deps.strategies` (a per-route factory / fixed array). LAZY on purpose (RFC §11.6): the legacy factory is
 * NEVER evaluated for a migrated cell, so its side effects — the handlers' `recordFeature("via-responses" /
 * "via-chat-completions-fallback")` — do not double-fire alongside the leg's `translateOut` (which now owns
 * that observability). Both the S4 exchange (runRequest) and the buffered-sink re-exchange resolve through here.
 */
function resolveExchangeStrategies(deps: DriverDeps, env: RequestEnvelope): ReadonlyArray<RetryStrategy> {
  const cell = migratedCell(env)
  if (cell) return cell.buildStrategies(env)
  return typeof deps.strategies === "function" ? deps.strategies(env) : (deps.strategies ?? [])
}

/**
 * S2 translateOut: the MIGRATED cell's leg owns it for every real request; a non-migrated env (a mock/legacy
 * driver-orchestration test codec) falls back to `deps.codec.translateOut`, or identity if the codec omits it.
 */
function outboundTranslateOut(deps: DriverDeps, env: RequestEnvelope): RequestEnvelope {
  const cell = migratedCell(env)
  if (cell) return cell.translateOut(env)
  return deps.codec.translateOut?.(env) ?? env
}

/**
 * S4-pre prepareWire: the MIGRATED cell's leg owns it for every real request; a non-migrated env falls back
 * to `deps.codec.prepareWire`. A non-migrated codec that omits it is a wiring bug (a mock must provide one).
 */
function outboundPrepareWire(deps: DriverDeps, env: RequestEnvelope): PreparedRequest {
  const cell = migratedCell(env)
  if (cell) return cell.prepareWire(env)
  const wire = deps.codec.prepareWire?.(env)
  if (!wire) throw new Error("[driver] prepareWire unavailable — a non-migrated codec must implement it (mock/legacy fallback)")
  return wire
}

/** S1→S4: ingest → route/translate → rewrite-in → exchange (error-driven retry). */
async function runRequest(deps: DriverDeps, raw: RawHttpRequest): Promise<DriverRequestResult> {
  // S1 — Ingest: parse inbound → envelope (codec builds ctx + extracts body/model).
  const parsed = deps.codec.parse(raw)

  // S2 — Translate-in: decideRoute (passthrough / translate / reject) + translateOut.
  // The route decision moved to the free-function `router.decideRoute` (ADR 2026-07-11),
  // resolved via `resolveRouteDecision` (test override → router).
  const decision = resolveRouteDecision(deps, parsed)
  if (decision.kind === "reject") {
    // No dangling history entry — reject before committing the request (aligns
    // with current messages:165 rejecting before context creation). Carry the
    // raw reason; the route/codec shapes the per-format error envelope.
    return { ok: false, rejection: { status: decision.status, reason: decision.reason, format: parsed.clientFormat } }
  }
  const targetEndpoint = decision.kind === "passthrough" ? decision.endpoint : decision.to
  // T1.6 route observability (RFC §10 / W6): record the leg pin + actual outbound leg +
  // translate-vs-direct label on the ctx (projected into history `model{}`). Optional-chained so a
  // mock/legacy ctx without the method is unaffected; direct requests record `translated:false`.
  parsed.ctx.setRouteInfo?.({
    ...(parsed.routeOverride && { routeOverride: parsed.routeOverride }),
    outboundEndpoint: targetEndpoint,
    translated: decision.kind === "translate",
    clientFormat: parsed.clientFormat,
  })
  const routedEnv = parsed.with({ targetEndpoint })
  const routed = outboundTranslateOut(deps, routedEnv)

  // S3 — Rewrite-in: assemble + run the request-rewrite chain.
  const rewritten = runRewriteIn(deps, routed)

  // Hook point: onRequest — one-shot logical-request rewrite, OUTSIDE the retry loop
  // (a per-attempt replay would clobber reactive strategies' env fixes — spec §3.2 H1).
  const hook = getUpstreamHook()
  const afterHook = hook?.onRequest ? (hook.onRequest(rewritten) ?? rewritten) : rewritten

  // S4 — Exchange: error-driven retry loop (prepareWire → transport → strategy re-env).
  // Resolve the strategy stack now that the envelope (model + codec state) exists. For a MIGRATED cell the
  // CellAssembly composes it (RETRY_SEMANTICS × the leg's wire strategies); else the legacy per-route
  // factory / fixed array. LAZY (resolveExchangeStrategies) — the legacy factory is not evaluated for a
  // migrated cell, so its recordFeature side effects do not double-fire with the leg's translateOut.
  const strategies = resolveExchangeStrategies(deps, afterHook)
  // C0-① (RFC §11.1): runExchange returns the POST-retry env (the final attempt's
  // env), not `rewritten` (pre-exchange). Consumers — e.g. the Anthropic pump
  // building the tool-call recoverer from env.body.tools, which deferred-tool-retry
  // mutates — must see what was actually sent on the successful attempt.
  //
  // C4a: the exchange (transport fetch + stream first-event + the RC3 retry/backoff loop) is
  // settle-BEFORE operation-body work — the exact orphan the user observed (a reaper/deadline
  // settled the request at 1200s while a 631s backoff kept running). Track its promise so the
  // shutdown drain (operationScopes) waits for it to actually unwind after a mid-flight settle.
  // Optional-chained for mock/legacy ctxs (same pattern as `setRouteInfo?.`).
  const exchangePromise = runExchange(deps, afterHook, strategies)
  // Runtime-optional for structural mock/legacy contexts that intentionally cast a narrowed ctx.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  parsed.ctx.trackOperationBody?.(exchangePromise)
  const { upstream, env: settled } = await exchangePromise
  return { ok: true, upstream, env: settled }
}

/** S3: assemble the request-rewrite chain and apply each in declared order. */
function runRewriteIn(deps: DriverDeps, env: RequestEnvelope): RequestEnvelope {
  let current = env
  // MIGRATED cell: the CellAssembly supplies the leg's request-rewrite chain; else the legacy deps array.
  const cell = migratedCell(env)
  const rewrites = cell ? cell.requestRewrites(env) : (deps.requestRewrites ?? BUILTIN_REQUEST_REWRITES)
  for (const rewrite of assembleRequestRewrites(current, rewrites)) {
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

  // S2 — route / translate. Via `resolveRouteDecision` (test override → free-function router).
  const decision = resolveRouteDecision(deps, parsed)
  if (decision.kind === "reject") return { stoppedAt: "reject", rejected: { status: decision.status, reason: decision.reason }, stages }
  const targetEndpoint = decision.kind === "passthrough" ? decision.endpoint : decision.to
  // MIGRATED cell: the assembly owns S2 translateOut / S3 requestRewrites / S4-pre prepareWire (mirrors
  // runRequest); a mock/legacy codec without requestState falls back to deps.codec / deps.requestRewrites.
  const routedEnv = parsed.with({ targetEndpoint })
  const routed = outboundTranslateOut(deps, routedEnv)
  stages.translate = { targetEndpoint: routed.targetEndpoint, body: snapshotBody(routed.body) }
  if (stopAfter === "translate") return { stoppedAt: "translate", stages }

  // S3 — rewrite-in (mirror runRewriteIn, capturing per-rewrite {name, changed}).
  const applied: Array<{ name: string; changed: boolean }> = []
  let current = routed
  const inspectCell = migratedCell(current)
  const inspectRewrites = inspectCell ? inspectCell.requestRewrites(current) : (deps.requestRewrites ?? BUILTIN_REQUEST_REWRITES)
  for (const rewrite of assembleRequestRewrites(current, inspectRewrites)) {
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
  const wire = outboundPrepareWire(deps, current)
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
  // First-attempt-only pre-send hook guard (Task 9): the codec may pre-truncate
  // env.body ONCE before the initial send; reactive retry takes over afterward, so
  // we never re-run it per attempt (which would re-truncate an already-trimmed body).
  let preflightDone = false

  for (;;) {
    // MIGRATED cell: preSend / prepareWire / sampleWireTrack come from the CellAssembly; else the codec.
    // Resolved per-iteration from `current` (a retry strategy may re-target the leg).
    const cell = migratedCell(current)
    if (!preflightDone) {
      preflightDone = true
      // MUST run before prepareWire below — otherwise the wire is built from the
      // un-truncated body and the pre-flight trim would not take effect this attempt.
      if (cell?.preSend) current = await cell.preSend(current)
      else if (deps.codec.preSend) current = await deps.codec.preSend(current)
    }
    const wire = outboundPrepareWire(deps, current)
    current.ctx.beginAttempt({ ...(activeStrategy && { strategy: activeStrategy.name }) })
    // S4 per-attempt sampling (P2.3-S): the codec / assembly derives the history effective +
    // wire request descriptors from the prepared wire + env (format-specific). The
    // attempt record exists (beginAttempt above); record both tracks on it.
    const sample = cell ? cell.sampleWireTrack(wire, current) : deps.codec.sampleRequest?.(wire, current)
    if (sample) {
      current.ctx.setAttemptEffectiveRequest(sample.effective)
      current.ctx.setAttemptWireRequest(sample.wire)
    }
    current.ctx.transition("executing")
    try {
      const hook = getUpstreamHook()
      const upstream =
        hook?.onExchange ? await hook.onExchange(wire, current, () => deps.transport.send(wire, current)) : await deps.transport.send(wire, current)
      // 首包埋点（spec 2026-07-14 §3.2）：上游响应头到达（每 attempt 各记自己的，绝对 epoch）。
      {
        current.ctx.setAttemptTimingEpoch?.("upstreamHeadersAt", Date.now(), "once")
      }
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
      // RC1/RC3 cancel coverage: a retry backoff must be interruptible by the same signals
      // that terminate an in-flight request — the stale reaper (`lifecycleSignal`, which the
      // reaper fires at deadline before force-settling), graceful shutdown, and client abort.
      // The legacy bare `delay()` ignored all three, so a request settled by the reaper kept
      // sleeping through an exponential backoff (631s observed) and then STARTED A NEW ATTEMPT —
      // one link in the 2800s overrun. `abortableDelay` rejects with an abort-classified error;
      // the attempt-boundary gate below also covers the waitMs===0 path. (C4b will fold the
      // per-request deadline signal into the same combine.)
      // The two signals that terminate a request are folded here: the stale reaper
      // (`lifecycleSignal`, fired at deadline before force-settling) and graceful shutdown.
      // (Client-abort is detected at the stream layer, not during backoff; C1 will thread it
      // + the deadline signal through the unified operationSignal.)
      const backoffSignal = combineAbortSignals(current.ctx.lifecycleSignal, getShutdownSignal())
      // Gate BEFORE the next attempt (covers waitMs===0): if the request is already being
      // cancelled, do not start another upstream attempt.
      if (backoffSignal?.aborted) throw new OperationCancelledError()
      // Count the retry backoff in queueWaitMs (legacy parity — pipeline.ts adds
      // action.waitMs to queueWaitMs in addition to the rate-limiter wait).
      if (action.waitMs) {
        current.ctx.addQueueWaitMs(action.waitMs)
        await abortableDelay(action.waitMs, backoffSignal)
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
  const rewrites = assembleResponseRewrites(env, migratedCell(env)?.responseRewrites(env) ?? deps.responseRewrites ?? BUILTIN_RESPONSE_REWRITES)
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
  const bufferedInputsByRewrite = new Map<string, Array<UpstreamFrame>>()
  const captureRewrite = (name: string, input: UpstreamFrame, action: FrameAction): void => {
    const transformId = `rewrite-out:${name}`
    if (action.kind === "buffer") {
      const buffered = bufferedInputsByRewrite.get(name) ?? []
      buffered.push(input)
      bufferedInputsByRewrite.set(name, buffered)
      env.ctx.captureGenerationFrameAction?.([input], [], { stage: "rewrite-out", transformId, action: "buffer" })
      return
    }
    const buffered = bufferedInputsByRewrite.get(name) ?? []
    bufferedInputsByRewrite.delete(name)
    const inputs = [...buffered, input]
    env.ctx.captureGenerationFrameAction?.(inputs, action.kind === "emit" ? action.frames : [], {
      stage: "rewrite-out",
      transformId,
      action: action.kind,
      forceDerived: action.kind === "emit" && action.frames.some((output) => output !== input || readSyntheticKind(output) !== undefined),
    })
  }
  const captureFlush = (name: string, outputs: ReadonlyArray<UpstreamFrame>): void => {
    const buffered = bufferedInputsByRewrite.get(name) ?? []
    bufferedInputsByRewrite.delete(name)
    env.ctx.captureGenerationFrameAction?.(buffered, outputs, {
      stage: "rewrite-out",
      transformId: `rewrite-out:${name}`,
      action: "flush",
      forceDerived: outputs.length > 0,
    })
  }

  // Task 2.2: the hook-mock/hook-replay origin tag (if the upstream stream was tagged via
  // `tagStream`) is constant for the WHOLE stream — read it ONCE outside the loop rather
  // than per-frame (spec LOW-2).
  const origin = readOrigin(upstream)

  try {
    for await (const frame of upstream.frames) {
      // Skip the `[DONE]` sentinel — it's a gateway-injected transport terminator
      // (OpenAI convention, NOT part of the Anthropic protocol; anthropic/stream.ts:104),
      // not a content frame. The accumulators skip it and the legacy Anthropic pump
      // broke before recording it, so excluding it keeps the upstream-original track to
      // real content frames (no mislabeled `type:"message"` sentinel) + matches the
      // pre-P3.2b Anthropic baseline. Forwarded never carried it either (pump breaks).
      if (frame.data !== "[DONE]") {
        const upstreamRecord: SseEventRecord = {
          offsetMs: Date.now() - streamStartMs,
          type: frame.event ?? (frame.data ? "message" : "keepalive"),
          raw: frame.data ?? "",
          ...(origin && { synthetic: origin }),
        }
        upstreamSse.push(upstreamRecord)
        env.ctx.captureUpstreamGenerationFrame?.(frame, upstreamRecord)
        if (upstreamSse.length === 1) env.ctx.setSseEvents(upstreamSse)
        // 首包埋点（spec 2026-07-14 §3.2）：上游 3 刻记到当前 attempt（绝对 epoch）。单点采样在
        // driver loop-top（每格式 raw 帧无条件流经此，Responses direct 也在此），谓词按 targetEndpoint。
        // message_start 为 Anthropic-format 专有帧，非-Anthropic 上游此刻恒 undefined（符合预期）。
        {
          const now = Date.now()
          if (frame.event === "message_start") env.ctx.setAttemptTimingEpoch?.("upstreamMessageStartAt", now, "once")
          if (isFirstUpstreamContent(frame, env.targetEndpoint)) env.ctx.setAttemptTimingEpoch?.("upstreamFirstTokenAt", now, "once")
          if (isUpstreamContentFrame(frame, env.targetEndpoint)) env.ctx.setAttemptTimingEpoch?.("upstreamLastTokenAt", now, "latest")
        }
        // Hand the raw upstream frame to the handler's upstream-side work (accumulate
        // → outboundResponse, repetition, progress, diagnostics) BEFORE the rewrite
        // chain (RFC §4.A1 — keeps those on the upstream-original, not the rewritten
        // frames the loop yields below). Same skip-[DONE] condition as upstreamSse.
        opts?.onUpstreamFrame?.(frame)
      }
      // Hook point: rewriteUpstreamFrame — per-frame rewrite AFTER upstream-original sampling,
      // so the upstream track keeps pre-hook real frames (spec §3.2/§3.4 H2). undefined → drop.
      const hook = getUpstreamHook()
      let effFrame: UpstreamFrame | undefined = frame
      if (hook?.rewriteUpstreamFrame && frame.data !== "[DONE]") {
        const rewritten = hook.rewriteUpstreamFrame(frame, env)
        // Task 2.3 (spec §3.4 decision 1/§9, plan-2 Task 2.3): a GENUINELY changed frame (a
        // NEW object — `undefined` means dropped, the SAME reference means the hook chose not
        // to rewrite this one) is tagged so the sink can mark its forwarded-track sample
        // `synthetic:"hook-rewrite"` — see hooks/origin.ts (`tagFrameRewritten`) for exactly
        // which downstream shapes preserve vs. lose the tag (passthrough-leg codecs + a
        // spreading `onRenderedFrame` preserve it; a translate-leg codec or a
        // fresh-literal-reconstructing `onRenderedFrame` — e.g. Responses' restoreAndAccumulate
        // — does not; a documented, accepted gap, not a defect of this mechanism).
        effFrame = rewritten !== undefined && rewritten !== frame ? tagFrameRewritten(rewritten) : rewritten
        if (effFrame === undefined) {
          env.ctx.captureGenerationFrameAction?.([frame], [], {
            stage: "rewrite-upstream-hook",
            transformId: "hook:rewrite-upstream-frame",
            action: "drop",
          })
        } else if (effFrame !== frame) {
          env.ctx.captureGenerationFrameTransform?.(frame, effFrame, {
            stage: "rewrite-upstream-hook",
            transformId: "hook:rewrite-upstream-frame",
            forceDerived: true,
          })
        }
      }
      // Guard the rewrite chain instead of `continue` — so `frameIndex++` below ALWAYS
      // runs (评审 LOW-1: `continue` would skip it, corrupting dry-run frame ordinals).
      // A dropped frame (undefined) just skips passThrough; frameIndex still advances.
      if (effFrame !== undefined) {
        // S5: thread the upstream frame through the rewrite chain (emit/suppress/buffer).
        for (const rewritten of passThrough([effFrame], rewrites, states, 0, sampleAction, captureRewrite)) {
          // S6 — Translate-out: render the (target-endpoint) frame to the client protocol.
          // skipRender (dry-run T1) yields the S5 frame verbatim — the consumer wants the
          // rewrite-chain output BEFORE the S6 render translation.
          if (opts?.skipRender) yield rewritten
          else yield* renderFrames(deps, rewritten, env)
        }
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
    for (const flushed of flushChain(rewrites, states, captureRewrite, captureFlush)) {
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
        env.ctx.captureGenerationFrameTransform?.(frame, toWrite, {
          stage: "client-transform",
          transformId: "client:on-rendered-frame",
          forceDerived: toWrite !== frame || readSyntheticKind(toWrite) !== undefined,
        })
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
 * L2 — transactional buffered retry (design §3, docs/archive/2606-landed-rfcs/streaming-upstream-rst-buffered-retry.md).
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
export async function runResponseBufferedSink(
  deps: DriverDeps,
  upstream: UpstreamStream,
  env: RequestEnvelope,
  sink: ClientSink,
  opts: RunBufferedOpts,
): Promise<ResponseOutcome> {
  const cap = opts.retryCap ?? 0
  const bufferCapBytes = opts.bufferCapBytes ?? 0
  const vendor = opts.telemetryVendor ?? "unknown"
  // Same lazy resolution as the S4 exchange: a migrated cell's buffered re-exchange uses the CellAssembly
  // stack, never the legacy factory (so no double recordFeature vs the leg's translateOut).
  const strategies = resolveExchangeStrategies(deps, env)
  let current = upstream
  let currentEnv = env
  let attempt = 0
  // Block-level commit tracking (P0 mechanism floor). Declared OUTSIDE the retry loop so it
  // persists across attempts: once a block is committed live (`commitBoundaries` flush), the
  // retry window is closed forever (a committed prefix is on the wire, un-retryable) and a later
  // truncation degrades to `partial-degrade` instead of retrying. Stays FALSE the whole time on
  // the terminal-only path (`commitBoundaries === undefined`) → the retry gate + terminal commit
  // are byte-identical to the whole-response behaviour (R1).
  let committedAny = false

  // Buffered empty-text keepalive anchor (spec 2026-07-08-buffered-keepalive-empty-text-anchor §3.2 +
  // §10.1.5 H1). The anchor STATE is now HANDLER-OWNED and threaded in via `opts.anchorState` so the
  // handler's UNIQUE injector (attached to the sink's `heartbeat.injectAnchor`) and this buffered
  // commit/close-off/remap observe ONE shared object — `injected`/`messageStartForwarded`/
  // `capturedMessageStart` flip on the same instance. The driver only ORCHESTRATES the buffered commit
  // side (freeze + close-off + +1 remap + message_start dedup); it no longer BUILDS an injector (that
  // moved to the handler, subsumed by the single `heartbeat.injectAnchor` slot — spec §10.1.5 C1 / B1).
  // The Anthropic handler supplies the format-specific frames + the message_start predicate via
  // `opts.anchor` (H2). `anchor` is present for BOTH synthetic-prelude modes (`empty_text` +
  // `enveloped_ping`) but undefined for `ping` / the live path; the commit branches read
  // `anchorState.anchorBlockOpen` to remap+close-off (`empty_text`) vs only dedup the message_start
  // (`enveloped_ping`). When `anchor` is undefined every anchor branch below is inert (byte-identical to
  // before). `anchorState` falls back to a driver-local object when the caller does not thread one (e.g. a
  // `ping`-mode buffered stream that never injects).
  const anchor = opts.anchor
  const anchorState = opts.anchorState ?? { injected: false, messageStartForwarded: false, anchorBlockOpen: false, anchorClosed: false }

  // Terminal-failure close-off (spec §3.3 M1): when the request FAILS after the anchor was injected (a
  // truncation/exhaustion, or a post-retreat truncation), the anchor's content_block_start@0 is still OPEN
  // on the forwarded track. The driver returns `stream-error` and the handler writes its protocol error
  // frame, but a dangling open block would leave the client's block structure unbalanced. Close it
  // (empty-text content_block_stop@0 — known-benign) BEFORE the failure return. `freezeHeartbeat` first so
  // no ping/anchor can fire between here and the stop write; the write is best-effort (the client may
  // already be gone — a reject is swallowed, there is nothing left to do). NOT called on client-abort /
  // settled-abort (the client is already gone → closing is meaningless). Idempotent — inert when the anchor
  // was never injected (fast responses) OR already closed. Setting `anchorState.anchorClosed` is
  // LOAD-BEARING for cross-site coordination (spec §10.5): after this returns `stream-error`, the pump's
  // own terminal-branch `closeAnchorIfOpen` reads the SAME shared `anchorClosed` and short-circuits, so the
  // buffered exhaustion path emits exactly ONE stop@0 (driver's), not a second from the pump.
  const closeAnchorIfOpen = async (): Promise<void> => {
    sink.freezeHeartbeat?.()
    // Only `empty_text` (anchorBlockOpen) reserved a content_block@0 that needs balancing; `enveloped_ping`
    // injected a message_start-only envelope (no block) → nothing to close off.
    if (anchorState.injected && anchor && anchorState.anchorBlockOpen && !anchorState.anchorClosed) {
      anchorState.anchorClosed = true
      try {
        await (sink.writeAnchor ?? sink.write)(anchor.stopFrame) // "anchor" marker (structural close-off)
      } catch {
        /* client gone mid-close — best-effort, nothing else to do */
      }
    }
  }

  // Shared buffered-frame flush (extracted so the terminal commit AND the block-level boundary
  // commit apply IDENTICAL anchor-aware semantics: heartbeat freeze → one-time anchor close-off →
  // H1 message_start dedup → +1 remap). Returns a discriminated result so the caller maps it to a
  // ResponseOutcome (never throws out). `firstFlush` makes the anchor close-off (which reserves
  // index 0 before the first REAL block) happen exactly once across all flushes — on the terminal-
  // only path (`commitBoundaries===undefined`) this is called ONCE, byte-identical to the previous
  // inline whole-response commit (R1). C1 (spec §3.3): freeze the heartbeat BEFORE snapshotting
  // `injected` + flushing so a mid-flush timer tick can't inject a second anchor start(0).
  let firstFlush = true
  type FlushResult = { kind: "ok" } | { kind: "client-abort" } | { kind: "write-error"; error: unknown }
  const flushBufferedFrames = async (frames: Array<ClientFrame>): Promise<FlushResult> => {
    sink.freezeHeartbeat?.()
    const injected = anchorState.injected
    const anchorBlockOpen = anchorState.anchorBlockOpen
    try {
      // M4: the anchor reserved index 0 → close it off (empty-text content_block_stop@0) BEFORE the
      // first real block flush, then shift every real content_block_* by +1. Sets the shared
      // `anchorClosed` guard (spec §10.5) so a later error terminus never emits a second stop@0.
      if (firstFlush && injected && anchor && anchorBlockOpen && !anchorState.anchorClosed) {
        anchorState.anchorClosed = true
        await (sink.writeAnchor ?? sink.write)(anchor.stopFrame) // "anchor" marker
      }
      for (const frame of frames) {
        // H1: the anchor already forwarded message_start ahead of the anchor block — skip the buffered
        // copy so the client sees exactly one message_start (re-sending it would corrupt the stream).
        if (anchor && anchorState.messageStartForwarded && anchor.isMessageStart(frame)) continue
        await sink.write(injected && anchor && anchorBlockOpen ? anchor.remap(frame, 1) : frame)
      }
      firstFlush = false
      return { kind: "ok" }
    } catch (error) {
      // Client gone mid-flush (a `sink.write` reject) — map it so the buffered sink ALWAYS returns a
      // ResponseOutcome, never a raw throw (mirrors runResponseSink's catch; the buffer is discarded).
      if (classifyStreamError(error) === "client-abort") return { kind: "client-abort" }
      return { kind: "write-error", error }
    }
  }

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
          currentEnv.ctx.captureGenerationFrameTransform?.(frame, toWrite, {
            stage: "client-transform",
            transformId: "client:on-rendered-frame",
            forceDerived: toWrite !== frame || readSyntheticKind(toWrite) !== undefined,
          })
          if (retreated) {
            // Buffer cap already exceeded → live write-through for the rest (no more buffering). When an anchor
            // was injected BEFORE the retreat, the live continuation must stay consistent with the retreat
            // flush's +1 remap (spec §6.3): shift every real content_block_* by +1 (the anchor holds @0) and
            // DROP a duplicate message_start (H1 — the injector already forwarded it). Inert (byte-identical to
            // the raw forward) when no anchor was injected — `injected`/`anchorBlockOpen` stay false.
            if (anchor && anchorState.messageStartForwarded && anchor.isMessageStart(toWrite)) continue // H1 dedup
            await sink.write(anchorState.injected && anchor && anchorState.anchorBlockOpen ? anchor.remap(toWrite, 1) : toWrite)
            continue
          }
          // Capture the FIRST message_start (before buffering it) into the SHARED anchorState so the
          // handler's unique idle injector can forward it AHEAD of the anchor block. It is STILL buffered
          // as normal — the commit flush skips the already-forwarded copy (H1 dedup below).
          if (anchor && anchorState.capturedMessageStart === undefined && anchor.isMessageStart(toWrite)) anchorState.capturedMessageStart = toWrite
          // 首包埋点（spec 2026-07-14 §3.2）：首帧被扣留进 buffer 的时刻（entry-level first hold，
          // 跨失败 retry；once 语义保留全局最早）。protect_streaming_generation 与 L2 共用此函数。
          if (buffer.length === 0) currentEnv.ctx.setClientTimingEpoch("bufferHoldStart", Date.now())
          buffer.push(toWrite)
          bufferedBytes += (toWrite.data?.length ?? 0) + (toWrite.event?.length ?? 0)
          if (bufferCapBytes > 0 && bufferedBytes > bufferCapBytes) {
            // OOM guard: abandon buffering, flush what we have, switch to live for the rest. The
            // response loses L2 protection (a live RST now fails) and is NOT retried (frames are
            // forwarded). Documented tradeoff (RFC §7 / §12 Q4) — pathological huge responses are rare.
            retreated = true
            opts.onRetreat?.()
            // §6.3: flush the buffered prefix through the SAME anchor-aware transform as the terminal commit
            // (one-time anchor close-off `stop@0` → H1 message_start dedup → +1 remap), so an anchor injected
            // before the retreat can't collide the real @0 block with the anchor's @0 or re-send message_start.
            // On the no-anchor path this is byte-identical to the previous raw `for (f of buffer) write(f)`
            // (every anchor branch inert). SUSPEND/RESUME (recoverable) around the flush — NOT the terminal
            // path's permanent freeze — because retreat is followed by MORE (live) streaming: a subsequent
            // live stall must still get keepalives (the anchor is now closed, so the tick emits a block-aware
            // empty delta on the live-open block, or a ping). `flushBufferedFrames`' internal freeze clears the
            // timer; resume re-arms a fresh interval so the heartbeat recovers for the live continuation.
            sink.suspendHeartbeat?.()
            const res = await flushBufferedFrames(buffer)
            sink.resumeHeartbeat?.()
            buffer.length = 0
            if (res.kind === "client-abort") return { kind: "settled-abort" }
            if (res.kind === "write-error") {
              // Client gone mid-retreat-flush — the forwarded prefix is on the wire (un-retryable). Surface as a
              // retreated resolution (never-swallow the write error). The `finally` closes the sink.
              opts.onBufferedResolve?.("retreated", attempt, { vendor })
              return { kind: "stream-error", error: res.error }
            }
          } else if (opts.commitBoundaries?.(toWrite)) {
            // Block-level commit (P0): this frame closes a block → flush the buffered frames up to and
            // including it, COMMITTING the block live. Inverts the commit point from "once at terminal
            // drain" to "at each boundary". `committedAny` closes the retry window (a committed prefix is
            // on the wire, un-retryable) and routes a later truncation to `partial-degrade`. Skipped
            // entirely when `commitBoundaries` is undefined → the terminal-only path is byte-identical (R1).
            //
            // §4.4 concurrency guard: SUSPEND the heartbeat around this per-block flush (recoverable), so a
            // tick firing on one of the loop's `await sink.write` yields can't splice an empty keepalive
            // delta into the middle of THIS real block's deltas. RESUME after — unlike the terminal path's
            // permanent freeze, the block-level flush is followed by MORE streaming, so the inter-block idle
            // must keep its keepalives. (`flushBufferedFrames`' internal freeze clears the timer; resume
            // re-arms a fresh interval, so the heartbeat recovers for the next inter-block gap.)
            sink.suspendHeartbeat?.()
            const res = await flushBufferedFrames(buffer)
            sink.resumeHeartbeat?.()
            buffer.length = 0
            committedAny = true
            if (res.kind === "client-abort") return { kind: "settled-abort" }
            if (res.kind === "write-error") {
              // A block committed, then the client-side write failed mid-commit — the committed prefix is
              // on the wire (un-retryable). Surface as a graceful degrade (never-swallow the write error).
              opts.onBufferedResolve?.("partial-degrade", attempt, { vendor })
              return { kind: "stream-error", error: res.error }
            }
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
        opts.onBufferedResolve?.("retreated", attempt, { vendor })
        if (drained) return { kind: "complete", headers: current.headers }
        // M1: a post-retreat truncation still leaves the anchor open (it was injected during an idle stall
        // before the retreat) → close it before surfacing the stream-error.
        await closeAnchorIfOpen()
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
        // Flush the buffered TAIL (everything after the last committed block boundary). On the
        // terminal-only path (`commitBoundaries===undefined`) `buffer` still holds the WHOLE
        // generation and this is the ONE flush — byte-identical to before (R1). On the block-level
        // path each boundary already flushed + emptied `buffer` in-loop, so this flushes only the
        // post-last-boundary tail — and when the terminal frame is ITSELF a boundary, `buffer` is
        // empty here, so the terminal is NOT re-flushed (M1 dedup: it reached the client exactly once
        // in-loop). `flushBufferedFrames` owns the freeze + one-time anchor close-off + H1 dedup + remap.
        const res = await flushBufferedFrames(buffer)
        if (res.kind === "client-abort") return { kind: "settled-abort" }
        if (res.kind === "write-error") {
          // Client gone mid-flush. L2 produced a COMPLETE generation (reached the terminal frame) — the
          // flush failed at the transport, NOT the retry: count it as a `success` so the hit-rate
          // denominator isn't a blind spot. The handler still settles the request as failed (delivery).
          opts.onBufferedResolve?.("success", attempt, { vendor })
          return { kind: "stream-error", error: res.error }
        }
        opts.onBufferedResolve?.("success", attempt, { vendor })
        return { kind: "complete", headers: current.headers }
      }

      // Failure: a transport-close throw, OR a clean drain WITHOUT a terminal frame (truncation).
      // Retry ONLY a transport-close throw (`"other"`) or a truncation (no throw) — never a
      // shutdown / idle-timeout throw. `!committedAny` closes the retry window once a block was
      // committed live (P0): a committed prefix is on the wire, so re-exchanging would double-send
      // it. On the terminal-only path `committedAny` is always false → the gate is unchanged (R1).
      const retryable = (thrown ? classifyStreamError(thrown) === "other" : true) && !committedAny
      if (retryable && attempt < cap) {
        attempt++
        // D1: snapshot THIS failed attempt's upstream-original frames onto the attempt BEFORE the
        // reset clears the top-level slot — so a failed attempt's frames survive for diagnosis.
        // (The final attempt — success-commit above OR exhaustion-return below — keeps its frames
        // at the top-level slot only, matching `extractStagePayloads`' finalIdx skip: no dup.)
        currentEnv.ctx.commitAttemptSseEvents()
        // BLOCK-1: L2 缓冲重试也发 attempt_failed → 打 [RETRY] 行，与 L1 一致可见。
        // 先定稿本次（截断/transport-close）attempt 的 durationMs（截断路径无 error/response setter）。
        currentEnv.ctx.finalizeCurrentAttemptDuration()
        currentEnv.ctx.recordAttemptFailure({ willRetry: true, nextStrategy: "buffered-retry" })
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
      // M1: close the still-open anchor (if injected) BEFORE the failure return so the client's block
      // structure is balanced when the handler appends its error frame.
      // 穷尽/非重试：最终失败 attempt 也 finalize duration，供终端汇总行 last（截断路径无 setter）。
      currentEnv.ctx.finalizeCurrentAttemptDuration()
      await closeAnchorIfOpen()
      // Block-level degrade (P0): a boundary block was ALREADY committed live, then the stream
      // truncated (the `!committedAny` gate above forced this branch, un-retryable). The committed
      // prefix is on the wire, so this is a GRACEFUL degrade — `partial-degrade`, distinct from
      // `exhausted` (which committed nothing). On the terminal-only path `committedAny` is always
      // false → `exhausted`, unchanged (R1).
      opts.onBufferedResolve?.(committedAny ? "partial-degrade" : "exhausted", attempt, { vendor })
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
  for (const rewrite of assembleResponseRewrites(env, migratedCell(env)?.responseRewrites(env) ?? deps.responseRewrites ?? BUILTIN_RESPONSE_REWRITES)) {
    if (rewrite.transformWhole) current = rewrite.transformWhole(current, env)
  }
  return current
}

/** S6 + S7: render one upstream frame to client frame(s) and surface them. */
function* renderFrames(deps: DriverDeps, frame: UpstreamFrame, env: RequestEnvelope): Generator<ClientFrame> {
  const rendered = deps.codec.renderResponse(frame, env)
  const frames = Array.isArray(rendered) ? rendered : [rendered]
  for (const out of frames) {
    env.ctx.captureGenerationFrameTransform?.(frame, out, {
      stage: "render",
      transformId: `render:${env.clientFormat}`,
      forceDerived: out !== frame || readSyntheticKind(out) !== undefined,
    })
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
  capture?: (rewriteName: string, input: UpstreamFrame, action: FrameAction) => void,
): Array<UpstreamFrame> {
  let current = frames
  for (let i = startIdx; i < rewrites.length; i++) {
    const next: Array<UpstreamFrame> = []
    for (const frame of current) {
      const action = rewrites[i].transform(frame, states[i])
      sample?.(rewrites[i].name, action)
      capture?.(rewrites[i].name, frame, action)
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
function flushChain(
  rewrites: ReadonlyArray<ResponseRewrite>,
  states: Array<RewriteState>,
  capture?: (rewriteName: string, input: UpstreamFrame, action: FrameAction) => void,
  captureFlush?: (rewriteName: string, outputs: ReadonlyArray<UpstreamFrame>) => void,
): Array<UpstreamFrame> {
  const out: Array<UpstreamFrame> = []
  for (let i = 0; i < rewrites.length; i++) {
    const flushed = rewrites[i].flush?.(states[i]) ?? []
    if (rewrites[i].flush !== undefined) captureFlush?.(rewrites[i].name, flushed)
    if (flushed.length > 0) out.push(...passThrough(flushed, rewrites, states, i + 1, undefined, capture))
  }
  return out
}
