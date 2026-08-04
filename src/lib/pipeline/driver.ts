/**
 * v4 pipeline — PipelineDriver (P2.1 skeleton).
 *
 * The data-flow driver: pushes a request through the seven stages (S1→S7),
 * publishing events / sampling raw data at the stage boundaries. Lifted+merged
 * from the pre-driver retry loops and handler orchestration skeletons (docs/v4/01-architecture.md §1.3, 03-spec/envelope-driver.md §3).
 *
 * P2.1 builds the format-agnostic skeleton; it consumes a {@link FormatCodec} +
 * {@link Transport} + retry strategies + the rewrite registry as opaque deps, so
 * the unit tests drive it with a mock codec/transport. No format is wired here —
 * the codecs (P2.2–P2.6) and route switches (P2.3+) come later.
 */

import consola from "consola"

import type {
  //
  CandidateHandle,
  CandidateRole,
  DispatchHandle,
} from "~/lib/context/model-operation-record"
import type { RequestContext } from "~/lib/context/request"
import type { OwnerFailure } from "~/lib/pipeline/delivery/owner-failure"
import type { FrozenHedgePolicy } from "~/lib/pipeline/generation/hedge-policy"

import { LiveOwnerFailureError } from "~/lib/anthropic/live-reconcile"
import { classifyError } from "~/lib/error"
import { recordAbortProvenanceGap } from "~/lib/observability/abort-provenance-gaps"
import { recordRetryGiveUp } from "~/lib/observability/retry-giveups"
import { recordRetryStrategyFire } from "~/lib/observability/retry-strategy-fires"
import { classifyOwnerFailure } from "~/lib/pipeline/delivery/owner-failure"
import {
  //
  DeliveryOwnerError,
  getDeliverySessionForAllocationPort,
  getDownstreamDeliverySession,
} from "~/lib/pipeline/delivery/session"
import { readSyntheticKind } from "~/lib/pipeline/frame-origin"
import { createGenerationBudget } from "~/lib/pipeline/generation/generation-budget"
import { getUpstreamHook } from "~/lib/pipeline/hooks/loader"
import {
  //
  classifyStreamError,
  StreamClientAbortError,
} from "~/lib/stream"
import {
  //
  getUpstreamAdmissionController,
  type UpstreamAdmissionController,
} from "~/lib/transport/admission-controller"
import { UpstreamTransportFallbackError } from "~/lib/transport/fallback"

import type { RequestEnvelope } from "./envelope"
import type {
  //
  AnchorState,
  ClientFrame,
  ClientSink,
  DriverRequestResult,
  FormatCodec,
  PhysicalTransport,
  PhysicalTransportResponse,
  PipelineDriver,
  PreparedRequest,
  RawHttpRequest,
  RequestInspectStage,
  RequestInspection,
  OwnerOperation,
  ResponseOutcome,
  RetryAction,
  RetryStrategy,
  RouteDecision,
  RunBufferedOpts,
  BufferedFlushContext,
  RunResponseOpts,
  Transport,
  TransportDispatchOptions,
  UpstreamStream,
} from "./types"

import {
  //
  type CellAssembly,
  isCellMigrated,
  resolveCellAssembly,
} from "./cell-assembly"
import { hasCompleteInteractiveToolUse } from "./committed-blocks-ledger"
import {
  //
  createCandidateRuntime,
  type CandidateRuntime,
} from "./generation/candidate"
import {
  //
  createDefaultCandidateResponseSession,
  type CandidateResponseSession,
  type CandidateResponseSessionFactory,
  type CandidateResponseSessionOptions,
} from "./generation/candidate-response-session"
import { createCandidateStateFactory } from "./generation/candidate-state"
import {
  //
  createGenerationCoordinator,
  type CoordinatedCandidate,
  type GenerationCoordinator,
} from "./generation/coordinator"
import {
  //
  createDispatchScheduler,
  type DispatchRecordingPort,
  type SemanticRetryDecision,
} from "./generation/dispatch-scheduler"
import {
  //
  assembleRequestRewrites,
  assembleResponseRewrites,
  BUILTIN_REQUEST_REWRITES,
  BUILTIN_RESPONSE_REWRITES,
  type RequestRewrite,
  type ResponseRewrite,
} from "./rewrite-registry"
import { decideRoute } from "./router"
/**
 * Everything the driver needs to orchestrate one format. The route layer (P2.3+)
 * selects the codec by prefix and constructs a driver per request.
 */
export interface DriverDeps {
  codec: FormatCodec
  transport: Transport & Partial<PhysicalTransport>
  /** Transport-independent queue/backoff policy; defaults to the process-global adaptive limiter. */
  admission?: UpstreamAdmissionController
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
  /** Format-specific candidate response state/accumulator factory. Omitted only by stateless mocks. */
  candidateResponseSessionFactory?: CandidateResponseSessionFactory
  /** Frozen per-generation fast-retry policy. Omitted means primary-only behavior. */
  hedgePolicy?: FrozenHedgePolicy
  monotonicNow?: () => number
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
  /** Current candidate response session; follows buffered recovery to its fresh child candidate. */
  getCandidateResponseSession(upstream: UpstreamStream): CandidateResponseSession | undefined
}

interface GenerationBinding {
  readonly coordinator: GenerationCoordinator<CandidateResponseSession>
  readonly candidate: CoordinatedCandidate<CandidateResponseSession>
}

interface DriverGenerationRuntime {
  readonly bindings: WeakMap<UpstreamStream, GenerationBinding>
  bind(coordinator: GenerationCoordinator<CandidateResponseSession>, candidate: CoordinatedCandidate<CandidateResponseSession>): GenerationBinding
  currentSession(upstream: UpstreamStream): CandidateResponseSession | undefined
}

function createDriverGenerationRuntime(): DriverGenerationRuntime {
  const bindings = new WeakMap<UpstreamStream, GenerationBinding>()
  const latestByCoordinator = new WeakMap<GenerationCoordinator<CandidateResponseSession>, CandidateResponseSession>()
  return {
    bindings,
    bind(coordinator, candidate) {
      const binding = { coordinator, candidate }
      bindings.set(candidate.upstream, binding)
      latestByCoordinator.set(coordinator, candidate.processor)
      return binding
    },
    currentSession(upstream) {
      const binding = bindings.get(upstream)
      return binding ? latestByCoordinator.get(binding.coordinator) : undefined
    },
  }
}

export function createPipelineDriver(deps: DriverDeps): PipelineDriverWithNonStreaming {
  const generation = createDriverGenerationRuntime()
  return {
    runRequest: (raw) => runRequest(deps, raw, generation),
    runResponse: (upstream, env, opts) => runResponse(deps, upstream, env, opts, generation),
    inspectRequest: (raw, stopAfter) => inspectRequest(deps, raw, stopAfter),
    runResponseNonStreaming: (upstream, env) => deps.codec.renderResponseNonStreaming(upstream.nonStream, env),
    runResponseWhole: (response, env) => runResponseWhole(deps, response, env),
    runResponseSink: (upstream, env, sink, opts) => trackResponsePump(env, runResponseSink(deps, upstream, env, sink, opts, generation)),
    runResponseBufferedSink: (upstream, env, sink, opts) => trackResponsePump(env, runResponseBufferedSink(deps, upstream, env, sink, opts, generation)),
    getCandidateResponseSession: (upstream) => generation.currentSession(upstream),
  }
}

function trackResponsePump(env: RequestEnvelope, pump: Promise<ResponseOutcome>): Promise<ResponseOutcome> {
  // Register the inner pump before returning it to the handler. Promise reactions run in
  // registration order, so the scope child settles before the handler continuation records its
  // logical terminal. The finalizer remains outside the scope and therefore cannot self-join.
  // Runtime-optional for structural mock contexts used by driver-only tests.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  env.ctx.trackOperationBody?.(pump)
  return pump
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
async function runRequest(deps: DriverDeps, raw: RawHttpRequest, generation: DriverGenerationRuntime): Promise<DriverRequestResult> {
  // S1a — Ingest: parse inbound → envelope (codec builds ctx + extracts body/model). SYNC.
  const parsed = deps.codec.parse(raw)

  // Hook point: client.inbound — one-shot client-NATIVE request rewrite, at S1a→S1b (before
  // translate/sanitize), the only point where every format's body is client-native (RFC §3/§3.5).
  // Defensive body snapshot: the hook receives a clone-backed env so an in-place mutation can't穿透
  // downstream (or into the frozen clientRequest history track); on `undefined` the driver keeps the
  // ORIGINAL parsed env (immutable-return semantics). `snapshotBody` is the codec-agnostic tolerant
  // structuredClone (falls back to the original for an unclonable body).
  const inboundHook = getUpstreamHook()?.client?.inbound
  const clientNative = inboundHook ? (inboundHook(parsed.with({ body: snapshotBody(parsed.body) })) ?? parsed) : parsed

  // S1b — Translate-in (async, RFC 2026-07-14 §3): per-format async inbound processing —
  // gemini `Gemini→CC` + each format's async system-prompt injection (awaits applyConfigToState).
  // Runs ONCE, outside the retry loop, after parse + client.inbound. No-op unless the codec
  // implements `translateInbound`.
  const ingested = (await deps.codec.translateInbound?.(clientNative)) ?? clientNative

  // S2 — Translate-out (route): decideRoute (passthrough / translate / reject) + translateOut.
  // The route decision moved to the free-function `router.decideRoute` (ADR 2026-07-11),
  // resolved via `resolveRouteDecision` (test override → router).
  const decision = resolveRouteDecision(deps, ingested)
  if (decision.kind === "reject") {
    // No dangling history entry — reject before committing the request (aligns
    // with current messages:165 rejecting before context creation). Carry the
    // raw reason; the route/codec shapes the per-format error envelope.
    return { ok: false, rejection: { status: decision.status, reason: decision.reason, format: ingested.clientFormat } }
  }
  const targetEndpoint = decision.kind === "passthrough" ? decision.endpoint : decision.to
  // T1.6 route observability (RFC §10 / W6): record the leg pin + actual outbound leg +
  // translate-vs-direct label on the ctx (projected into history `model{}`). Optional-chained so a
  // mock/legacy ctx without the method is unaffected; direct requests record `translated:false`.
  ingested.ctx.setRouteInfo?.({
    ...(ingested.routeOverride && { routeOverride: ingested.routeOverride }),
    outboundEndpoint: targetEndpoint,
    translated: decision.kind === "translate",
    clientFormat: parsed.clientFormat,
  })
  const routedEnv = ingested.with({ targetEndpoint })
  const routed = outboundTranslateOut(deps, routedEnv)

  // S3 — Rewrite-in: assemble + run the request-rewrite chain.
  const rewritten = runRewriteIn(deps, routed)

  // Hook point: upstream.outbound (was onRequest) — one-shot upstream-bound request rewrite,
  // OUTSIDE the retry loop (a per-attempt replay would clobber reactive strategies' env fixes
  // — spec §3.2 H1 / RFC §3).
  const hook = getUpstreamHook()
  const afterHook = hook?.upstream?.outbound ? (hook.upstream.outbound(rewritten) ?? rewritten) : rewritten

  // S4 — the primary-only GenerationCoordinator is now the sole production owner of
  // prepare/admission/physical-open/reactive retry topology. No legacy retry loop runs beside it.
  const preflight = await runGenerationPreflight(deps, afterHook)
  const coordinator = createDriverCoordinator(deps, preflight)
  const exchangePromise = coordinator.runPrimary()
  // Runtime-optional for structural mock contexts, preserving the existing operation-scope seam.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  parsed.ctx.trackOperationBody?.(exchangePromise)
  const candidate = await exchangePromise
  generation.bind(coordinator, candidate)
  return { ok: true, upstream: candidate.upstream, env: candidate.env }
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
async function inspectRequest(deps: DriverDeps, raw: RawHttpRequest, stopAfter: RequestInspectStage): Promise<RequestInspection> {
  const stages: RequestInspection["stages"] = {}

  // S1a — parse (sync).
  const parsed = deps.codec.parse(raw)
  stages.parse = { clientFormat: parsed.clientFormat, targetEndpoint: parsed.targetEndpoint, model: parsed.model, body: snapshotBody(parsed.body) }
  if (stopAfter === "parse") return { stoppedAt: "parse", stages }

  // S1b — translate-inbound (async, RFC 2026-07-14 §3): per-format async inbound processing.
  // No-op unless the codec implements `translateInbound` (then this stage's body == parse's).
  const ingested = (await deps.codec.translateInbound?.(parsed)) ?? parsed
  stages["translate-inbound"] = { body: snapshotBody(ingested.body) }
  if (stopAfter === "translate-inbound") return { stoppedAt: "translate-inbound", stages }

  // S2 — route / translate. Via `resolveRouteDecision` (test override → free-function router).
  const decision = resolveRouteDecision(deps, ingested)
  if (decision.kind === "reject") return { stoppedAt: "reject", rejected: { status: decision.status, reason: decision.reason }, stages }
  const targetEndpoint = decision.kind === "passthrough" ? decision.endpoint : decision.to
  // MIGRATED cell: the assembly owns S2 translateOut / S3 requestRewrites / S4-pre prepareWire (mirrors
  // runRequest); a mock/legacy codec without requestState falls back to deps.codec / deps.requestRewrites.
  const routedEnv = ingested.with({ targetEndpoint })
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
async function runGenerationPreflight(deps: DriverDeps, env: RequestEnvelope): Promise<RequestEnvelope> {
  const cell = migratedCell(env)
  if (cell?.preSend) return cell.preSend(env)
  if (deps.codec.preSend) return deps.codec.preSend(env)
  return env
}

function createDriverCoordinator(deps: DriverDeps, initialEnv: RequestEnvelope): GenerationCoordinator<CandidateResponseSession> {
  const recording = createDriverRecordingPort(deps, initialEnv.ctx)
  const perCandidateDispatchBudget = Math.max(16, 1 + deps.maxRetries + deps.maxLearningRetries)
  // Serial candidate headroom: 1 primary + the shared retry/continuation budget (spec 2026-07-22 §5.2 —
  // transparent retries AND continuation legs each open a candidate). Sized from deps.maxRetries so a
  // higher-than-default config does not trip the candidate cap; the continuation branch ALSO degrades
  // gracefully if this is somehow exceeded (best-effort). Hedge configs override via hedgePolicy.
  const maxTotalCandidates = deps.hedgePolicy?.maxTotalCandidates ?? Math.max(5, 1 + deps.maxRetries)
  const generationBudget = createGenerationBudget({
    maxActiveCandidates: deps.hedgePolicy?.maxActiveCandidates ?? 2,
    maxTotalCandidates,
    maxActiveDispatches: deps.hedgePolicy?.maxActiveDispatches ?? 2,
    maxTotalDispatches: deps.hedgePolicy?.maxTotalDispatches ?? perCandidateDispatchBudget * maxTotalCandidates,
  })
  const candidateStateFactory = deps.codec.createCandidateStateFactory?.(initialEnv) ?? createCandidateStateFactory(initialEnv, {})
  const createCandidate = ({
    role,
    parentCandidate,
    env,
  }: {
    role: CandidateRole
    parentCandidate?: CandidateHandle
    env: RequestEnvelope
  }): CandidateRuntime<CandidateResponseSession> => {
    const retry = createSemanticRetryPolicy(deps)
    const scheduler = createDispatchScheduler({
      prepareWire: (current) => outboundPrepareWire(deps, current),
      open: (wire, current, options) => openPhysicalDispatch(deps, wire, current, options),
      admission: deps.admission ?? getUpstreamAdmissionController(),
      recording,
      decideRetry: retry,
      maxDispatches: perCandidateDispatchBudget,
      ...(deps.monotonicNow && { monotonicNow: deps.monotonicNow }),
      generationBudget,
    })
    return createCandidateRuntime({
      role,
      ...(parentCandidate !== undefined && { parentCandidate }),
      env,
      forkEnv(candidate) {
        const fork = candidateStateFactory.fork({ candidateId: String(candidate), role })
        return env.with({
          // The coordinator-provided env may carry accepted reactive/buffered-recovery copy-on-write
          // changes. Fork only opaque requestState here; never rewind body/prepareHints to generation start.
          body: env.body,
          prepareHints: structuredClone(env.prepareHints),
          requestState: fork.requestState,
        })
      },
      recording,
      scheduler,
      createProcessor: ({ candidate, dispatch, env: processorEnv }) => {
        const responseRewrites = migratedCell(processorEnv)?.responseRewrites(processorEnv) ?? deps.responseRewrites ?? BUILTIN_RESPONSE_REWRITES
        const renderer = deps.codec.createCandidateRenderer?.(processorEnv) ?? {
          renderResponse: (frame: import("./types").UpstreamFrame, requestEnv: RequestEnvelope) => deps.codec.renderResponse(frame, requestEnv),
          flushResponse: () => [],
        }
        const createSession = deps.candidateResponseSessionFactory ?? createDefaultCandidateResponseSession
        return createSession({ candidate, dispatch, env: processorEnv, responseRewrites, renderer })
      },
    })
  }
  return createGenerationCoordinator({ env: initialEnv, createCandidate, generationBudget })
}

/**
 * Bounded one-line excerpt of an upstream error message for a log line. Full bodies already land in
 * history (richest-data-flow); the log only needs enough to recognise a NEW upstream wording.
 */
function excerptForLog(message: string, max = 300): string {
  const flat = message.replaceAll(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

function createSemanticRetryPolicy(deps: DriverDeps): (input: import("./generation/dispatch-scheduler").SemanticRetryInput) => Promise<SemanticRetryDecision> {
  let normalRetries = 0
  let learningRetries = 0
  let candidateStrategies: ReadonlyArray<RetryStrategy> | undefined
  return async ({ env, error }) => {
    // Resolve only after CandidateStateFactory forked env.requestState. Strategy closures (notably
    // beta-probe and reverse resanitize) must bind this candidate's supplies, never generation-shared ones.
    const strategy = (candidateStrategies ??= resolveExchangeStrategies(deps, env)).find((candidate) => candidate.canHandle(error))
    if (!strategy) {
      // NOBODY understood this rejection. The loudest give-up: it means our matchers have drifted
      // from what upstream actually says, and the client is about to receive the raw error. Both
      // illegal-thinking-layout incidents (2026-07-26 C2, 2026-07-27 C3) lived here silently and were
      // found only when a human pasted the 400 back at us — hence a warn AND a counter, not a
      // bare `fail`. The message excerpt is what identifies a new upstream wording, so it is logged
      // (internal-tool posture: diagnostic value over hypothetical leakage).
      recordRetryGiveUp("unclaimed", error.type)
      consola.warn(
        `[Driver] No retry strategy claimed this ${error.type}${error.status ? ` (HTTP ${error.status})` : ""} — surfacing it to the client as-is: ${excerptForLog(error.message)}`,
      )
      return { kind: "fail" }
    }
    let action: RetryAction
    try {
      action = await strategy.handle(error, env)
    } catch (strategyError) {
      recordRetryGiveUp("strategy-threw", error.type)
      consola.warn(
        `[Driver] Strategy "${strategy.name}" threw while handling the error:`,
        strategyError instanceof Error ? strategyError.message : strategyError,
      )
      return { kind: "fail" }
    }
    if (action.kind === "abort") {
      // The strategy recognised the error but decided its remedy does not apply to THIS payload
      // (e.g. poisoned-thinking-retry declining a literal assistant prefill). Legitimate, but a
      // rising count means a matcher claims more than it can cure — and while it claims, no other
      // strategy gets a look (first match wins).
      recordRetryGiveUp("strategy-abort", error.type)
      consola.warn(`[Driver] Strategy "${strategy.name}" claimed this ${error.type} but declined to retry it: ${excerptForLog(error.message)}`)
      return { kind: "fail" }
    }
    const overBudget = action.learning ? learningRetries++ >= deps.maxLearningRetries : normalRetries++ >= deps.maxRetries
    if (overBudget) {
      recordRetryGiveUp("budget-exhausted", error.type)
      consola.warn(`[Driver] Retry budget exhausted while strategy "${strategy.name}" was still willing to retry this ${error.type}`)
      return { kind: "fail" }
    }
    if (action.meta) deps.onMeta?.(action.meta, action.env)
    action.env.ctx.recordAttemptFailure({
      willRetry: true,
      nextStrategy: strategy.name,
      ...(action.waitMs !== undefined && { waitMs: action.waitMs }),
      ...(action.learning && { learning: true }),
    })
    // Per-strategy fire telemetry (RFC 2026-07-21-retry-strategy-registry §3.5 / plan Task 5): SAME
    // commit point as recordAttemptFailure above — only a budget-ACCEPTED retry (past the overBudget
    // gate, past the abort check) counts as a "fire". A structurally never-throw Map increment (no I/O,
    // no external call), so no try/catch is needed here — mirrors `recordToolInputRepair`'s call sites.
    recordRetryStrategyFire(strategy.name)
    if (action.waitMs) action.env.ctx.addQueueWaitMs(action.waitMs)
    return {
      kind: "retry",
      env: action.env,
      reason: strategy.name,
      ...(action.waitMs !== undefined && { waitMs: action.waitMs }),
      onResolved: (resolvedEnv) => strategy.onResolved?.(resolvedEnv, action.meta),
    }
  }
}

function createDriverRecordingPort(deps: DriverDeps, ctx: RequestContext): DispatchRecordingPort {
  let candidateSequence = 0
  let dispatchSequence = 0
  const candidateRoles = new Map<CandidateHandle, CandidateRole>()
  const explicit =
    typeof ctx.beginGenerationCandidate === "function"
    && typeof ctx.beginGenerationDispatch === "function"
    && typeof ctx.settleGenerationCandidate === "function"
    && typeof ctx.settleGenerationDispatch === "function"
    && typeof ctx.markGenerationDispatchSynthetic === "function"
  const fallbackCandidates = new Set<CandidateHandle>()

  const selectSample = (wire: PreparedRequest, env: RequestEnvelope) => {
    const cell = migratedCell(env)
    return cell ? cell.sampleWireTrack(wire, env) : deps.codec.sampleRequest?.(wire, env)
  }

  return {
    beginCandidate(input) {
      const handle = explicit ? ctx.beginGenerationCandidate(input) : (`compat-candidate:${++candidateSequence}` as CandidateHandle)
      candidateRoles.set(handle, input.role)
      if (!explicit) fallbackCandidates.add(handle)
      return handle
    },

    settleCandidate(candidate, settlement) {
      if (explicit) ctx.settleGenerationCandidate(candidate, settlement)
    },

    beginDispatch({ candidate, reason, strategy: explicitStrategy, wire, env }) {
      const strategy = explicitStrategy ?? (reason === "initial" ? undefined : reason)
      const handle =
        explicit ? ctx.beginGenerationDispatch({ candidate, ...(strategy && { strategy }) }) : (`compat-dispatch:${++dispatchSequence}` as DispatchHandle)
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- mock/legacy contexts intentionally exercise the temporary serial adapter until P9 removes it
      if (!explicit) ctx.beginAttempt({ ...(strategy && { strategy }) })
      const sample = selectSample(wire, env)
      if (sample) {
        if (explicit) {
          ctx.setGenerationDispatchEffectiveRequest(handle, sample.effective)
          ctx.setGenerationDispatchWireRequest(handle, sample.wire)
          // Every dispatch owned by a continuation-role candidate reuses the synthesized body. The future
          // max_tokens success path calls runContinuation too, so it inherits this provenance automatically.
          if (candidateRoles.get(candidate) === "continuation") ctx.markGenerationDispatchSynthetic(handle, "continuation")
        } else {
          ctx.setAttemptEffectiveRequest(sample.effective)
          ctx.setAttemptWireRequest(sample.wire)
        }
      }
      ctx.setHttpHeaders({ request: Object.fromEntries(wire.headers.entries()) })
      ctx.transition("executing")
      return handle
    },

    recordAdmission(_dispatch, permit) {
      ctx.addQueueWaitMs(permit.queueWaitMs)
    },

    recordOpened(dispatch, response) {
      if (response.kind === "stream" || response.kind === "json") {
        const headers = Object.fromEntries((response.kind === "stream" ? response.upstream.headers : response.headers).entries())
        if (Object.keys(headers).length > 0) {
          ctx.setHttpHeaders({ response: headers })
          if (explicit) ctx.setGenerationDispatchResponseHeaders(dispatch, headers)
          else ctx.setAttemptResponseHeaders(headers)
        }
        if (explicit) ctx.setGenerationDispatchTimingEpoch(dispatch, "upstreamHeadersAt", Date.now(), "once")
        else ctx.setAttemptTimingEpoch?.("upstreamHeadersAt", Date.now(), "once")
        return
      }
      const error = classifyError(response.error)
      if (explicit) ctx.setGenerationDispatchError(dispatch, error)
      else ctx.setAttemptError(error)
      if (error.responseHeaders) {
        const headers = Object.fromEntries(error.responseHeaders.entries())
        ctx.setHttpHeaders({ response: headers })
        if (explicit) ctx.setGenerationDispatchResponseHeaders(dispatch, headers)
        else ctx.setAttemptResponseHeaders(headers)
      }
    },

    settleDispatch(dispatch, settlement) {
      // A `discarded` retry OR a `continued` continuation hand-off (spec 2026-07-22 §5.3) records the
      // attempt's next strategy so the History [RETRY] diagnostic + attempt_failed telemetry show it
      // (`nextStrategy` distinguishes "buffered-retry" from "continuation"). A `continued` parent
      // partially delivered but a continuation exchange follows → `willRetry: true` is accurate.
      if ((settlement.verdict === "discarded" || settlement.verdict === "continued") && settlement.retryNextStrategy)
        ctx.recordAttemptFailure({
          willRetry: true,
          nextStrategy: settlement.retryNextStrategy,
          ...(settlement.waitMs !== undefined && { waitMs: settlement.waitMs }),
        })
      if (explicit) ctx.settleGenerationDispatch(dispatch, settlement)
    },
  }
}

async function openPhysicalDispatch(
  deps: DriverDeps,
  wire: PreparedRequest,
  env: RequestEnvelope,
  options?: TransportDispatchOptions,
): Promise<PhysicalTransportResponse> {
  const exchange = getUpstreamHook()?.exchange
  if (!exchange && deps.transport.open) return (deps.transport as PhysicalTransport).open(wire, env, options)
  try {
    const upstream = exchange ? await exchange(wire, env, () => deps.transport.send(wire, env, options)) : await deps.transport.send(wire, env, options)
    const lifecycle = upstream.lifecycle ?? settledDispatchLifecycle()
    // Preserve the producer's UpstreamStream identity: hook origin/provenance and callers use the
    // object itself as the dispatch artifact. Adding the migration lifecycle in place avoids a
    // semantically lossy wrapper while keeping hook mocks compatible.
    const ownedUpstream = Object.assign(upstream, { lifecycle })
    // A hook may deliberately replay a recorded stream for a request whose original body did not
    // set `stream`. Its returned artifact is authoritative at this boundary; non-stream responses
    // are distinguished by an explicit `nonStream` body.
    if (wire.stream || (exchange !== undefined && upstream.nonStream === undefined)) return { kind: "stream", upstream: ownedUpstream, lifecycle }
    return { kind: "json", body: upstream.nonStream, headers: upstream.headers, lifecycle }
  } catch (error) {
    const lifecycle = settledDispatchLifecycle()
    if (error instanceof UpstreamTransportFallbackError) return { kind: "fallback-before-first-event", error: error.dispatchError, lifecycle }
    return { kind: "failed-open", error, lifecycle }
  }
}

function settledDispatchLifecycle(): import("./types").UpstreamDispatchLifecycle {
  return {
    cancel() {},
    async dispose() {
      return { quiesced: true, connectionReusable: false }
    },
    quiesced: Promise.resolve(),
  }
}

// ============================================================================
// Response side (S5→S7)
// ============================================================================

/** S5→S7: construct and return the branch-local processor iterable without an extra async-generator delegation layer. */
function runResponse(
  deps: DriverDeps,
  upstream: UpstreamStream,
  env: RequestEnvelope,
  opts?: RunResponseOpts,
  generation?: DriverGenerationRuntime,
  applyPostRender = true,
): AsyncIterable<ClientFrame> {
  const coordinated = generation?.bindings.get(upstream)?.candidate.processor
  if (coordinated) {
    const effectiveOpts = mergeCandidateResponseOpts(coordinated.responseOpts, opts)
    const frames = coordinated.processor.stream(upstream, effectiveOpts)
    return applyPostRender && !effectiveOpts.skipRender ? applyResponsePostRender(frames, effectiveOpts) : frames
  }
  // Direct response-only callers (dry-run and focused processor tests) have no S4 generation.
  // This compatibility adapter still creates exactly one processor and owns no retry loop.
  const responseRewrites = migratedCell(env)?.responseRewrites(env) ?? deps.responseRewrites ?? BUILTIN_RESPONSE_REWRITES
  const renderer = deps.codec.createCandidateRenderer?.(env) ?? {
    renderResponse: (frame: import("./types").UpstreamFrame, requestEnv: RequestEnvelope) => deps.codec.renderResponse(frame, requestEnv),
    flushResponse: () => [],
  }
  const session = createDefaultCandidateResponseSession({
    candidate: "compat-response-candidate" as CandidateHandle,
    dispatch: "compat-response-dispatch" as DispatchHandle,
    env,
    responseRewrites,
    renderer,
  })
  const effectiveOpts = mergeCandidateResponseOpts(session.responseOpts, opts)
  const frames = session.processor.stream(upstream, effectiveOpts)
  return applyPostRender && !effectiveOpts.skipRender ? applyResponsePostRender(frames, effectiveOpts) : frames
}

async function* applyResponsePostRender(frames: AsyncIterable<ClientFrame>, opts: RunResponseOpts): AsyncIterable<ClientFrame> {
  for await (const frame of frames) {
    const transformed = opts.onRenderedFrame ? opts.onRenderedFrame(frame) : frame
    if (transformed) yield transformed
  }
}

function mergeCandidateResponseOpts(candidate: CandidateResponseSessionOptions | undefined, outer: RunResponseOpts | undefined): RunResponseOpts {
  if (!candidate) return outer ?? {}
  return { ...outer, ...candidate }
}

function currentCandidateResponseOpts(
  generation: DriverGenerationRuntime | undefined,
  upstream: UpstreamStream,
  outer: RunResponseOpts | RunBufferedOpts | undefined,
): RunResponseOpts | RunBufferedOpts {
  const candidate = generation?.currentSession(upstream)?.responseOpts
  return candidate ? { ...outer, ...candidate } : (outer ?? {})
}

async function maybeRunHedgedResponseSink(
  deps: DriverDeps,
  upstream: UpstreamStream,
  env: RequestEnvelope,
  sink: ClientSink,
  outerOpts: RunResponseOpts | RunBufferedOpts | undefined,
  generation: DriverGenerationRuntime | undefined,
): Promise<ResponseOutcome | undefined> {
  const policy = deps.hedgePolicy
  const runtime = generation
  const binding = runtime?.bindings.get(upstream)
  if (!policy?.enabled || !runtime || !binding || !env.stream) return undefined
  // Explicit buffered-recovery mode retains its sequential multi-candidate topology until P7-T3
  // folds recovery and hedge budgets into one coordinator. Silently replacing N recoveries with
  // one hedge would weaken an operator-enabled durability contract.
  if (outerOpts && "retryCap" in outerOpts) return undefined

  const snapshot = env.ctx.modelOperationSnapshot
  const activeCandidates = snapshot.candidates.filter((candidate) => candidate.verdict === undefined).length
  const activeDispatches = snapshot.dispatches.filter((dispatch) => dispatch.verdict === undefined).length
  const thresholdAtMs = binding.candidate.dispatchedAtMonotonic + policy.thresholdMs
  const future = policy.evaluate({
    nowMs: thresholdAtMs,
    primaryDispatchedAtMs: binding.candidate.dispatchedAtMonotonic,
    wire: binding.candidate.wire,
    semanticContentCommitted: false,
    winnerSelected: false,
    cancelled: env.ctx.cancelled,
    settled: env.ctx.settled,
    secondaryCandidates: snapshot.candidates.filter((candidate) => candidate.role === "hedge").length,
    activeCandidates,
    totalCandidates: snapshot.candidates.length,
    activeDispatches,
    totalDispatches: snapshot.dispatches.length,
  })
  if (!future.eligible) return undefined

  const primary = withCandidateResponseOpts(binding.candidate, outerOpts)
  const now = (deps.monotonicNow ?? performance.now.bind(performance))()
  try {
    const raced = await binding.coordinator.racePrimaryWithDelayedHedge({
      primary,
      delayMs: Math.max(0, thresholdAtMs - now),
      startHedge: async () => {
        const hedge = await binding.coordinator.runHedge(env)
        runtime.bind(binding.coordinator, hedge)
        return withCandidateResponseOpts(hedge, outerOpts)
      },
    })
    if (raced.kind === "failure") {
      binding.coordinator.releaseCandidate(binding.candidate.candidate)
      if (classifyStreamError(raced.error) === "client-abort") return { kind: "settled-abort" }
      return streamErrorOutcome(raced.error, env)
    }

    const selected = raced.candidate
    runtime.bind(binding.coordinator, selected)
    env.ctx.selectGenerationWinner(selected.candidate, selected.dispatch)
    const source = { candidateId: String(selected.candidate), dispatchId: String(selected.dispatch) }
    const allocationPort = outerOpts?.wireAllocationPort ?? getDownstreamDeliverySession(sink)?.allocationPort
    if (allocationPort?.wireState) {
      const leg = await allocationPort.beginLeg("primary", source)
      if (!leg.ok) return ownerFailureOutcome(leg, "begin-leg", env)
    }
    getDownstreamDeliverySessionForPortOrSink(outerOpts?.wireAllocationPort, sink)?.noteWinner(source)
    if (raced.kind === "terminal") {
      await writeWinnerFrames(sink, raced.bufferedFrames)
      binding.coordinator.releaseCandidate(selected.candidate)
      return { kind: "complete", headers: selected.upstream.headers, ...(selected.processor.finish && { finish: selected.processor.finish }) }
    }

    env.ctx.trackOperationBody(raced.loserCleanup)
    await writeWinnerFrames(sink, raced.bufferedFrames)
    for await (const frame of raced.liveFrames) await writeWinnerFrame(sink, frame)
    binding.coordinator.releaseCandidate(selected.candidate)
    return { kind: "complete", headers: selected.upstream.headers, ...(selected.processor.finish && { finish: selected.processor.finish }) }
  } catch (error) {
    binding.coordinator.releaseCandidate(binding.candidate.candidate)
    if (classifyStreamError(error) === "client-abort") return { kind: "settled-abort" }
    return streamErrorOutcome(error, env)
  } finally {
    sink.close?.()
  }
}

function withCandidateResponseOpts(
  candidate: CoordinatedCandidate<CandidateResponseSession>,
  outer: RunResponseOpts | RunBufferedOpts | undefined,
): CoordinatedCandidate<CandidateResponseSession> {
  if (!outer) return candidate
  const session = candidate.processor
  return {
    ...candidate,
    processor: {
      identity: session.identity,
      candidate: session.candidate,
      dispatch: session.dispatch,
      renderer: session.renderer,
      processor: session.processor,
      responseOpts: mergeCandidateResponseOpts(session.responseOpts, outer),
      boundary: session.boundary,
      get finish() {
        return session.finish
      },
      snapshot: () => session.snapshot(),
    },
  }
}

function ownerFailureOutcome(failure: OwnerFailure, operation: OwnerOperation, env: RequestEnvelope): ResponseOutcome {
  const decision = classifyOwnerFailure(failure, operation, { settled: env.ctx.settled })
  if (decision.kind === "client-aborted") return { kind: "settled-abort" }
  if (decision.kind === "delivery-finished") return { kind: "delivery-finished" }
  return streamErrorOutcome(decision.error, env)
}

function getDownstreamDeliverySessionForPortOrSink(
  port: RunResponseOpts["wireAllocationPort"],
  sink: ClientSink,
): ReturnType<typeof getDownstreamDeliverySession> {
  return port ? getDeliverySessionForAllocationPort(port) : getDownstreamDeliverySession(sink)
}

async function writeWinnerFrames(sink: ClientSink, frames: ReadonlyArray<ClientFrame>): Promise<void> {
  for (const frame of frames) await sink.write(frame)
}

async function writeWinnerFrame(sink: ClientSink, frame: ClientFrame): Promise<void> {
  await sink.write(frame)
}

/**
 * The SINGLE place a `stream-error` outcome is minted — and therefore the one funnel where a
 * post-header provenance gap can be counted for EVERY transport.
 *
 * The count first lived in `dispatch-lifecycle`, on the belief that both transports' frames pass
 * through `ownFrames()`. They do not: the Responses upstream-WebSocket success leg returns its own
 * lifecycle and never wraps its generator, so that leg produced a deterministic FALSE ZERO —
 * the worst failure mode for a gap detector, since a zero then reads as "no gaps". The driver sees
 * every transport, so it is the honest funnel.
 *
 * Use this instead of a bare `{ kind: "stream-error", error }` literal; `tests/architecture`
 * guards that.
 */
function streamErrorOutcome(error: unknown, env: RequestEnvelope, truncated?: boolean): { kind: "stream-error"; error: unknown; truncated?: boolean } {
  if (classifyStreamError(error) === "unknown-cancel") recordAbortProvenanceGap("post-header", env.clientFormat)
  return { kind: "stream-error" as const, error, ...(truncated !== undefined && { truncated }) }
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
  generation?: DriverGenerationRuntime,
): Promise<ResponseOutcome> {
  const hedged = await maybeRunHedgedResponseSink(deps, upstream, env, sink, opts, generation)
  if (hedged) return hedged
  const unhedgedBinding = generation?.bindings.get(upstream)
  if (unhedgedBinding) {
    env.ctx.selectGenerationWinner(unhedgedBinding.candidate.candidate, unhedgedBinding.candidate.dispatch)
    const allocationPort = opts?.wireAllocationPort ?? getDownstreamDeliverySession(sink)?.allocationPort
    if (allocationPort?.wireState) {
      const leg = await allocationPort.beginLeg("primary", {
        candidateId: String(unhedgedBinding.candidate.candidate),
        dispatchId: String(unhedgedBinding.candidate.dispatch),
      })
      if (!leg.ok) return ownerFailureOutcome(leg, "begin-leg", env)
    }
  }
  const effectiveOpts = currentCandidateResponseOpts(generation, upstream, opts) as RunResponseOpts
  let finish: import("./types").ResponseFinishResult | undefined
  const responseOpts: RunResponseOpts = {
    ...effectiveOpts,
    ...(effectiveOpts.finishResponse && {
      onFinishResolved(result: import("./types").ResponseFinishResult) {
        finish = result
        effectiveOpts.onFinishResolved?.(result)
      },
    }),
  }
  try {
    for await (const frame of runResponse(deps, upstream, env, responseOpts, generation, false)) {
      // Drop the `[DONE]` transport sentinel — never written to a sink (the format's
      // handler synthesizes its own trailing terminator; Anthropic emits none).
      if (frame.data === "[DONE]") continue
      // Post-render, pre-write transform (CC/Responses tool-name restore + accumulate/progress
      // side effects); identity when the format doesn't supply one (Anthropic). Applied AFTER
      // the `[DONE]` drop so the hook never sees the sentinel. A `undefined` return SKIPS the
      // frame (Responses drops empty/unparseable frames the legacy loop never forwarded).
      const toWrite = effectiveOpts.onRenderedFrame ? effectiveOpts.onRenderedFrame(frame) : frame
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
        if (effectiveOpts.stopAfterFrame?.(toWrite)) break
      }
    }
    return { kind: "complete", headers: upstream.headers, ...(finish && { finish }) }
  } catch (error) {
    // A client disconnect (the transport guard's StreamClientAbortError, or any error
    // classified client-abort) settles as abort — the handler writes nothing further.
    if (classifyStreamError(error) === "client-abort") return { kind: "settled-abort" }
    if (error instanceof LiveOwnerFailureError) return ownerFailureOutcome(error.failure, "close-anchor-before-real", env)
    // Otherwise surface the RAW error (richest-data-flow): the format handler classifies
    // it, shapes its protocol error frame, logs diagnostics, and settles ctx.fail.
    return streamErrorOutcome(error, env)
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
  generation?: DriverGenerationRuntime,
): Promise<ResponseOutcome> {
  const hedged = await maybeRunHedgedResponseSink(deps, upstream, env, sink, opts, generation)
  if (hedged) return hedged
  const allocationPort = opts.wireAllocationPort ?? getDownstreamDeliverySession(sink)?.allocationPort
  const unhedgedBinding = generation?.bindings.get(upstream)
  if (unhedgedBinding) {
    env.ctx.selectGenerationWinner(unhedgedBinding.candidate.candidate, unhedgedBinding.candidate.dispatch)
    if (allocationPort?.wireState) {
      const leg = await allocationPort.beginLeg("primary", {
        candidateId: String(unhedgedBinding.candidate.candidate),
        dispatchId: String(unhedgedBinding.candidate.dispatch),
      })
      if (!leg.ok) return ownerFailureOutcome(leg, "begin-leg", env)
    }
  }
  const cap = opts.retryCap ?? 0
  const bufferCapBytes = opts.bufferCapBytes ?? 0
  const vendor = opts.telemetryVendor ?? "unknown"
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

  // Continuation-retry (spec 2026-07-22 §4-§5, ADR D3). Present ⇒ a mid-stream cut AFTER a committed block
  // runs a synthetic continuation exchange whose frames are STITCHED onto the SAME client stream. State
  // persists across legs like `committedAny`:
  //   - `continuationCount`: continuation legs so far (shared budget + telemetry §5.3 split, distinct from
  //     the transparent-retry `attempt`).
  //   - `wireDeliveredBlocks`: content blocks delivered to the client so far — the re-index offset for the
  //     NEXT continuation leg. Counts thinking too (it occupies a wire index), UNLIKE the ledger which
  //     excludes it (C3: offset MUST be the wire count, not the ledger length — exp/continuation-stitch).
  //   - `continuationOffset`: fixed for the CURRENT leg = `wireDeliveredBlocks` at leg start; 0 on the
  //     primary/recovery legs so `continuation.remap(_, 0)` is inert.
  //   - `onContinuationLeg`: the current leg is a continuation exchange → drop its duplicate message_start.
  // Scoped to the anchor-DORMANT path (D2 default `stream_keepalive_mode: ping`, PoC-validated); the
  // empty_text-anchor + continuation combo is an untested corner (backlog).
  const continuation = opts.continuation
  const continuationOriginalBody = env.body // the ORIGINAL client body (spec §4.1 — cache-friendly; every continuation leg builds from [original] + [full ledger])
  let continuationCount = 0
  let wireDeliveredBlocks = 0
  let continuationOffset = 0
  let onContinuationLeg = false

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
  const anchorState: Pick<AnchorState, "injected" | "messageStartForwarded" | "anchorBlockOpen" | "anchorClosed" | "capturedMessageStart"> =
    opts.anchorState ?? {
      injected: false,
      messageStartForwarded: false,
      anchorBlockOpen: false,
      anchorClosed: false,
    }

  // Terminal-failure close-off (spec §3.3 M1): when the request FAILS after the anchor was injected (a
  // truncation/exhaustion, or a post-retreat truncation), the anchor's content_block_start@0 is still OPEN
  // on the forwarded track. The driver returns `stream-error` and the handler writes its protocol error
  // frame, but a dangling open block would leave the client's block structure unbalanced. Close it
  // (empty-text content_block_stop@0 — known-benign) BEFORE the failure return. `close()` first so
  // no ping/anchor can fire between here and the stop write; the write is best-effort (the client may
  // already be gone — a reject is swallowed, there is nothing left to do). NOT called on client-abort /
  // settled-abort (the client is already gone → closing is meaningless). Idempotent — inert when the anchor
  // was never injected (fast responses) OR already closed. Setting `anchorState.anchorClosed` is
  // LOAD-BEARING for cross-site coordination (spec §10.5): after this returns `stream-error`, the pump's
  // own terminal-branch `closeAnchorIfOpen` reads the SAME shared `anchorClosed` and short-circuits, so the
  // buffered exhaustion path emits exactly ONE stop@0 (driver's), not a second from the pump.
  const closeAnchorViaOwner = async (mode: "before-real" | "terminal"): Promise<ResponseOutcome | undefined> => {
    if (mode === "terminal") sink.close?.()
    if (!anchor) return undefined
    const port = allocationPort
    if (!port?.wireState) return undefined
    const operation: OwnerOperation = mode === "terminal" ? "close-anchor-terminal" : "close-anchor-before-real"
    try {
      const closed = await port.closeOpenAnchor((index, envelope) => envelope.anchor(anchor.stopFrame(index)), mode)
      return closed.ok ? undefined : ownerFailureOutcome(closed, operation, env)
    } catch (error) {
      if (!(error instanceof DeliveryOwnerError)) throw error
      return streamErrorOutcome(error, env)
    }
  }

  // Shared buffered-frame flush (extracted so the terminal commit AND the block-level boundary
  // commit apply IDENTICAL anchor-aware semantics: heartbeat freeze → one-time anchor close-off →
  // H1 message_start dedup → +1 remap). Returns a discriminated result so the caller maps it to a
  // ResponseOutcome (never throws out). SEQUENTIAL anchor (spec 2026-07-22 §3.3): the anchor reserved
  // index 0 and is closed (`content_block_stop@0`) BEFORE the first real `content_block_start` — the
  // per-frame close-off in the loop below (`isContentBlockStart` → closeAnchorBeforeReal) does this on
  // EVERY flush that carries a real block, so at most ONE content block is ever open at a time (the
  // anchor-COEXIST shape — anchor@0 kept open across real blocks — stalls the Claude Code CLI agent loop,
  // exp/block-level-anchor-sequential). `isTerminalFlush` drives the TOP-of-flush close-off, which is only
  // load-bearing for the ZERO-CONTENT terminus (a completion or `error` before any real block — the
  // per-frame close-off never fires) and the one-shot RETREAT flush (which forfeits buffering and hands
  // off to live write-through — the anchor is closed there so the live continuation's +1-remapped real
  // blocks don't sit under a dangling anchor; locked by retreat-anchor-collision.test.ts). Real blocks are
  // still shifted +1 (a single pre-content anchor holds @0). NOTE: after the anchor closes, an inter-block
  // idle degrades to a BARE ping (no open block to carry an empty `text_delta@0`); resetting CC's 300s
  // no-real-content watchdog for >300s inter-block gaps is a SEPARATE concern (docs/todo/
  // 2026-07-22-client-proxy-keepalive-300s.md). On the whole-response path (`commitBoundaries===undefined`)
  // the SINGLE flush IS the terminal → `isTerminalFlush:true`, byte-identical to the previous inline
  // whole-response commit (R1). C1 (spec §3.3): freeze the heartbeat BEFORE snapshotting `injected` +
  // flushing so a mid-flush timer tick can't inject a second anchor start(0).
  type FlushResult = { kind: "ok" } | { kind: "client-abort" } | { kind: "write-error"; error: unknown }
  const flushBufferedFrames = async (
    frames: Array<ClientFrame>,
    isTerminalFlush: boolean,
    mergeCtx: BufferedFlushContext,
    transformBufferedFlush?: RunBufferedOpts["transformBufferedFlush"],
  ): Promise<FlushResult> => {
    sink.freezeHeartbeat?.()
    try {
      // SEQUENTIAL anchor (spec 2026-07-22 §3.3): close the pre-content anchor (empty-text
      // content_block_stop@0) BEFORE the first real content block — NOT at the terminal flush — so no two
      // content blocks are ever open at once (the anchor-COEXIST shape stalls the Claude Code CLI agent
      // loop, exp/block-level-anchor-sequential/FINDINGS.md). This mirrors the live path
      // (live-reconcile.ts:125-142). Real blocks are still shifted +1 (the anchor reserved index 0). The
      // `anchorClosed` guard makes it fire exactly once. Terminal-flush close-off (zero-content completion /
      // error before any real block) is preserved by the SAME guard below via `closeAnchorBeforeReal`.
      // NOTE: after the anchor closes, an inter-block idle carries a BARE ping (no open anchor). Resetting
      // CC's 300s no-real-content watchdog for >300s inter-block gaps is a SEPARATE concern — see
      // docs/todo/2026-07-22-client-proxy-keepalive-300s.md. G2's historical failure was caused by the
      // recover-tool-call response rewrite swallowing empty text deltas, not by CC rejecting the carrier;
      // empty deltas now pass through, while the current default remains bare ping by the D2 decision.
      // <300s gaps + the 60s byte-idle are covered by the bare ping.
      const closeAnchorBeforeReal = async (): Promise<void> => {
        const closeOutcome = await closeAnchorViaOwner("before-real")
        if (closeOutcome?.kind === "settled-abort") throw new StreamClientAbortError()
        if (closeOutcome?.kind === "stream-error") throw closeOutcome.error
      }
      // Zero-content terminal (message_delta/stop or error before ANY real block): close the anchor here so
      // it never dangles open (symmetry with live-reconcile's terminal close-off).
      if (isTerminalFlush) await closeAnchorBeforeReal()
      // Candidate-hosted buffered-merge seam (spec §4): the reducer's transform replaces the raw buffer
      // with its (possibly compacted / repaired) frames just before write. Undefined = verbatim (R1).
      const toFlush = transformBufferedFlush ? transformBufferedFlush(frames, mergeCtx) : frames
      for (const frame of toFlush) {
        // H1: the anchor already forwarded message_start ahead of the anchor block — skip the buffered
        // copy so the client sees exactly one message_start (re-sending it would corrupt the stream).
        if (anchor && anchorState.messageStartForwarded && anchor.isMessageStart(frame)) continue
        // Continuation stitch (spec §4.4): a continuation leg's upstream emits its OWN message_start (new
        // id/usage) — DROP it so the client sees exactly one message_start across the whole stitched stream.
        if (continuation && onContinuationLeg && continuation.isMessageStart(frame)) continue
        // Close the anchor off BEFORE the first real content_block_start (sequential — never coexist).
        if (anchor?.isContentBlockStart(frame)) await closeAnchorBeforeReal()
        // Continuation re-index (C3): shift this leg's content_block_* by the wire-delivered block count
        // (continuationOffset), so continuation blocks continue the client's index sequence. Inert on the
        // primary leg (offset 0). Applied on top of any anchor remap (mutually exclusive in practice — the
        // continuation path is anchor-dormant).
        const anchorShift = allocationPort?.wireState?.allocator.anchorsOpened() ?? 0
        let outFrame = anchor && anchorShift > 0 ? anchor.remap(frame, 1) : frame
        if (continuation && continuationOffset > 0) outFrame = continuation.remap(outFrame, continuationOffset)
        // Count every content block delivered to the client (incl. thinking) — the offset for the NEXT
        // continuation leg (C3: wire count, not ledger length).
        if (continuation && continuation.isContentBlockStart(frame)) wireDeliveredBlocks++
        await sink.write(outFrame)
      }
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
      const candidateOpts = currentCandidateResponseOpts(generation, current, opts) as RunBufferedOpts
      const notifyBufferedResolve = candidateOpts.onBufferedResolve ?? opts.onBufferedResolve
      const buffer: Array<ClientFrame> = []
      let bufferedBytes = 0
      let retreated = false
      let thrown: unknown
      let drained = false
      let finish: import("./types").ResponseFinishResult | undefined
      const responseOpts: RunBufferedOpts = {
        ...candidateOpts,
        ...(candidateOpts.finishResponse && {
          onFinishResolved(result: import("./types").ResponseFinishResult) {
            finish = result
            candidateOpts.onFinishResolved?.(result)
          },
        }),
      }
      try {
        for await (const frame of runResponse(deps, current, currentEnv, responseOpts, generation, false)) {
          if (frame.data === "[DONE]") continue
          const toWrite = candidateOpts.onRenderedFrame ? candidateOpts.onRenderedFrame(frame) : frame
          if (!toWrite) continue
          currentEnv.ctx.captureGenerationFrameTransform?.(frame, toWrite, {
            stage: "client-transform",
            transformId: "client:on-rendered-frame",
            forceDerived: toWrite !== frame || readSyntheticKind(toWrite) !== undefined,
          })
          if (retreated) {
            // Buffer cap already exceeded → live write-through for the rest (no more buffering). When an anchor
            // was injected BEFORE the retreat, the live continuation stays SEQUENTIAL (spec 2026-07-22 §3.3):
            // close the anchor (stop@0) before the first real content_block_start so no two blocks are ever
            // open at once (never coexist — CLI-safe), then shift every real content_block_* by +1 and DROP a
            // duplicate message_start (H1 — the injector already forwarded it). Inert (byte-identical to the raw
            // forward) when no anchor was injected — `injected`/`anchorBlockOpen` stay false.
            if (anchor && anchorState.messageStartForwarded && anchor.isMessageStart(toWrite)) continue // H1 dedup
            if (anchor?.isContentBlockStart(toWrite)) {
              const closeOutcome = await closeAnchorViaOwner("before-real")
              if (closeOutcome?.kind === "settled-abort") return closeOutcome
              if (closeOutcome?.kind === "stream-error") return closeOutcome
            }
            const anchorShift = allocationPort?.wireState?.allocator.anchorsOpened() ?? 0
            await sink.write(anchor && anchorShift > 0 ? anchor.remap(toWrite, 1) : toWrite)
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
            // (every anchor branch inert). SUSPEND/RESUME (recoverable) around the flush — NOT a terminal
            // close — because retreat is followed by MORE (live) streaming: a subsequent
            // live stall must still get keepalives (the anchor is now closed, so the tick emits a block-aware
            // empty delta on the live-open block, or a ping). `flushBufferedFrames`' internal freeze clears the
            // timer; resume re-arms a fresh interval so the heartbeat recovers for the live continuation.
            sink.suspendHeartbeat?.()
            const res = await flushBufferedFrames(buffer, true, { cause: "retreat" }, candidateOpts.transformBufferedFlush)
            sink.resumeHeartbeat?.()
            buffer.length = 0
            if (res.kind === "client-abort") return { kind: "settled-abort" }
            if (res.kind === "write-error") {
              // Client gone mid-retreat-flush — the forwarded prefix is on the wire (un-retryable). Surface as a
              // retreated resolution (never-swallow the write error). The `finally` closes the sink.
              notifyBufferedResolve?.("retreated", attempt, { vendor })
              return streamErrorOutcome(res.error, env)
            }
          } else if (candidateOpts.commitBoundaries?.(toWrite)) {
            // Block-level commit (P0): this frame closes a block → flush the buffered frames up to and
            // including it, COMMITTING the block live. Inverts the commit point from "once at terminal
            // drain" to "at each boundary". `committedAny` closes the retry window (a committed prefix is
            // on the wire, un-retryable) and routes a later truncation to `partial-degrade`. Skipped
            // entirely when `commitBoundaries` is undefined → the terminal-only path is byte-identical (R1).
            //
            // §4.4 concurrency guard: SUSPEND the heartbeat around this per-block flush (recoverable), so a
            // tick firing on one of the loop's `await sink.write` yields can't splice an empty keepalive
            // delta into the middle of THIS real block's deltas. RESUME after — unlike a terminal close, the
            // block-level flush is followed by MORE streaming, so the inter-block idle must keep its
            // keepalives. (`flushBufferedFrames`' internal freeze clears the timer; resume
            // re-arms a fresh interval, so the heartbeat recovers for the next inter-block gap.)
            sink.suspendHeartbeat?.()
            // §5.3/§10.5 H2 ordering: `error` is BOTH a commit boundary AND the response terminus. When it
            // commits in-loop it must flush as a TERMINAL flush so the anchor close-off `content_block_stop@0`
            // is emitted BEFORE the buffered error frame (symmetry with the live-pump reconcile path,
            // tests/anthropic/live-pump-terminal-anchor-closeoff.http.test.ts H2 branch, and the buffered
            // success terminus). `sawUpstreamError()` is already true here — `onUpstreamFrame` (runResponse)
            // ran before this frame reached the loop. A `content_block_stop` boundary is mid-stream (more
            // blocks may follow) → NOT terminal → close-off stays deferred to the real terminus. The later
            // terminal drain (`drained && sawUpstreamError()`) re-enters `flushBufferedFrames(_, true)` with an
            // EMPTY buffer and the `anchorClosed` guard short-circuits the second stop@0 (idempotent).
            // Under the SEQUENTIAL model the per-frame close-before-real (flushBufferedFrames loop:
            // `isContentBlockStart` → closeAnchorBeforeReal) closes the anchor BEFORE every real block —
            // primary AND recovery-candidate alike (a recovery candidate's first committed block also
            // carries a `content_block_start`, so the loop handles it). The top-of-flush `isTerminalFlush`
            // close-off is therefore only LOAD-BEARING for the ZERO-CONTENT `error` terminus (no real block
            // buffered → the per-frame close-off never fires), where it must emit `content_block_stop@0`
            // BEFORE the forwarded error frame. `sawUpstreamError()` is already true here (`onUpstreamFrame`
            // ran before this frame reached the loop). The OLD `attempt > 0` term was dead (the per-frame
            // close-off already covers recovery-candidate blocks) and was removed;
            // `anchor-multiblock-lifecycle.it.test.ts (c′)` locks the error-terminus ordering.
            const isErrorTerminusFlush = opts.sawUpstreamError?.() ?? false
            // Continuation-retry ledger feed (spec 2026-07-22 §4.2 / persistence-async-invariants §3
            // "record signals at the committed settle point"): snapshot the frames that are ABOUT to commit
            // BEFORE `buffer` is cleared, then record their canonical blocks into the ledger ONLY on a
            // successful flush. A partial block (cut mid-generation) never reaches a boundary, so it is never
            // fed. Inert when no ledger/extractor is wired (Gemini / terminal-only / continuation disabled).
            const committedFrames = opts.committedBlocksLedger && opts.extractCommittedBlocks ? [...buffer] : undefined
            const res = await flushBufferedFrames(
              buffer,
              isErrorTerminusFlush,
              { cause: "boundary", boundaryFrame: toWrite },
              candidateOpts.transformBufferedFlush,
            )
            sink.resumeHeartbeat?.()
            buffer.length = 0
            committedAny = true
            if (res.kind === "client-abort") return { kind: "settled-abort" }
            if (res.kind === "write-error") {
              // A block committed, then the client-side write failed mid-commit — the committed prefix is
              // on the wire (un-retryable). Surface as a graceful degrade (never-swallow the write error).
              notifyBufferedResolve?.("partial-degrade", attempt, { vendor })
              return streamErrorOutcome(res.error, env)
            }
            // Commit succeeded (frames are on the wire) → record the delivered blocks into the continuation
            // ledger. Done AFTER the successful flush so a write-error above never records an undelivered
            // block. A zero-content `error` boundary yields no blocks (extractor drops non-content frames).
            if (committedFrames && opts.committedBlocksLedger && opts.extractCommittedBlocks) {
              for (const block of opts.extractCommittedBlocks(committedFrames)) opts.committedBlocksLedger.recordCommitted(block)
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
        notifyBufferedResolve?.("retreated", attempt, { vendor })
        if (drained) return { kind: "complete", headers: current.headers, ...(finish && { finish }) }
        // M1: a post-retreat truncation still leaves the anchor open (it was injected during an idle stall
        // before the retreat) → close it before surfacing the stream-error.
        const closeOutcome = await closeAnchorViaOwner("terminal")
        if (closeOutcome && closeOutcome.kind !== "stream-error") return closeOutcome
        return (
          closeOutcome
          ?? streamErrorOutcome(thrown ?? new Error("upstream stream truncated: closed without message_stop"), env, thrown === null || thrown === undefined)
        )
      }

      // COMMIT on a clean drain that reached a TERMINAL upstream state: `message_stop` (success),
      // an upstream `error` frame (H2 — a terminal upstream decision such as overload, NOT a
      // transport cut), OR a contentless refusal (an equally terminal upstream decision that is NOT
      // guaranteed to be followed by `message_stop`). Without the refusal arm a refusal that ends
      // without a terminator looks like truncation, so the driver would retry or continue a stream
      // whose complete terminus the refusal rewriter has ALREADY delivered to the client. A clean drain with NEITHER is a truncation (Bun delivers a clean RST as a
      // normal `end`, rstCode=0, undetectable — transport/http2-client.ts:169-175) → retryable.
      // Committing H2 flushes the buffered upstream error frame to the client and lets the handler
      // fail via `acc.streamError`, exactly mirroring the live path (NOT a wasteful retry that would
      // also relabel the real error as "truncated" on exhaustion). The committing attempt's frames
      // live at the top-level slot, so they are NOT snapshotted per-attempt here — only a FAILED
      // (retried) attempt gets a per-attempt `sseEvents` row (D1), set in the retry branch below.
      if (drained && (candidateOpts.sawMessageStop?.() || candidateOpts.sawUpstreamError?.() || candidateOpts.sawContentlessRefusal?.())) {
        // Flush the buffered TAIL (everything after the last committed block boundary). On the
        // terminal-only path (`commitBoundaries===undefined`) `buffer` still holds the WHOLE
        // generation and this is the ONE flush — byte-identical to before (R1). On the block-level
        // path each boundary already flushed + emptied `buffer` in-loop, so this flushes only the
        // post-last-boundary tail — and when the terminal frame is ITSELF a boundary, `buffer` is
        // empty here, so the terminal is NOT re-flushed (M1 dedup: it reached the client exactly once
        // in-loop). `flushBufferedFrames` owns the freeze + one-time anchor close-off + H1 dedup + remap.
        // `isTerminalFlush:true` — this is the response terminus, so the anchor's reserved @0 is closed off
        // here (defect (b): it stayed OPEN across every earlier block boundary; now it closes at the end —
        // and unconditionally, even when this tail buffer is EMPTY because the terminal frame was itself a
        // boundary). On the whole-response path this is the single flush → still terminal (R1 byte-identical).
        // This is a true response terminus: permanently stop heartbeat BEFORE the first flush write.
        // Unlike retreat/boundary flushes there is no subsequent stream that needs resume. Closing here
        // also blocks an in-flight heartbeat operation's finally-handler from re-arming during a slow flush.
        sink.close?.()
        const res = await flushBufferedFrames(buffer, true, { cause: "terminal-drain" }, candidateOpts.transformBufferedFlush)
        if (res.kind === "client-abort") return { kind: "settled-abort" }
        if (res.kind === "write-error") {
          // Client gone mid-flush. L2 produced a COMPLETE generation (reached the terminal frame) — the
          // flush failed at the transport, NOT the retry: count it as a `success` so the hit-rate
          // denominator isn't a blind spot. The handler still settles the request as failed (delivery).
          notifyBufferedResolve?.("success", attempt, { vendor, ...(continuationCount > 0 && { continuationRetries: continuationCount }) })
          return streamErrorOutcome(res.error, env)
        }
        notifyBufferedResolve?.("success", attempt, { vendor, ...(continuationCount > 0 && { continuationRetries: continuationCount }) })
        return { kind: "complete", headers: current.headers, ...(finish && { finish }) }
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
        // Finalize the failed response duration before the coordinator settles this dispatch and
        // emits the single buffered-retry compatibility event through the recording port.
        currentEnv.ctx.finalizeCurrentAttemptDuration()
        opts.onAttemptReset?.()
        currentEnv.ctx.resetRepairOutcomesForAttempt()
        currentEnv.ctx.resetSseEvents()
        // L2 escalation (RFC §8): let the caller tighten this retry's env (e.g. force aggressive
        // context_management) so the regenerated response is smaller/faster. Format-agnostic — the
        // driver just threads the returned env into the next exchange.
        if (opts.escalate) currentEnv = opts.escalate(currentEnv, attempt)
        const parent = generation?.bindings.get(current)
        // Direct response-helper tests do not have an S4 generation binding for the original
        // upstream. Keep their temporary serial compatibility event until P9 removes this API;
        // every production request has `parent` and emits exactly once through settleDispatch.
        if (!parent) currentEnv.ctx.recordAttemptFailure({ willRetry: true, nextStrategy: "buffered-retry" })
        const coordinator = parent?.coordinator ?? createDriverCoordinator(deps, currentEnv)
        const recovered =
          parent ?
            await coordinator.runRecovery(parent.candidate, thrown ? "transport-close" : "truncated-before-terminal", currentEnv)
          : await coordinator.runPrimary()
        generation?.bind(coordinator, recovered)
        currentEnv.ctx.selectGenerationWinner(recovered.candidate, recovered.dispatch)
        if (allocationPort?.wireState) {
          const leg = await allocationPort.beginLeg("recovery", {
            candidateId: String(recovered.candidate),
            dispatchId: String(recovered.dispatch),
          })
          if (!leg.ok) return ownerFailureOutcome(leg, "begin-leg", env)
        }
        current = recovered.upstream
        currentEnv = recovered.env
        continue
      }

      // Continuation-retry (spec 2026-07-22 §4-§5, ADR D3): committedAny is TRUE here (a block is on the
      // wire, so the transparent-retry gate above forced this branch) AND the stream was cut. Instead of
      // degrading, run a synthetic continuation exchange whose frames stitch onto the SAME client stream.
      // Gated so it never fires on the terminal-only path (committedAny false) or when unwired:
      //   - continuation hooks + ledger + extractor all present (handler wires them together);
      //   - the cut is a truncation / transport-close (same error class as the retry gate);
      //   - ADR D3: the committed prefix has NO complete interactive tool_use (that is a legitimate turn
      //     boundary — the client runs the tool — so we terminate normally, NOT continue);
      //   - shared budget (transparent retries + continuations ≤ cap) with a ONE-TIME floor of 1 on the
      //     first continuation (spec §5.2 (a)): the incident value must not be starved by pre-first-block
      //     retries. `continuationBudget` decrements to 0 afterwards → `continuation-exhausted` is reachable.
      const ledger = opts.committedBlocksLedger
      const remainingShared = cap - attempt - continuationCount
      const continuationBudget = continuationCount === 0 ? Math.max(remainingShared, 1) : remainingShared
      const canContinue =
        committedAny
        && (thrown ? classifyStreamError(thrown) === "other" : true)
        && continuation !== undefined
        && continuation.enabled
        && ledger !== undefined
        && opts.extractCommittedBlocks !== undefined
        && continuationBudget > 0
        && !hasCompleteInteractiveToolUse(ledger.snapshot())
      if (canContinue) {
        continuationCount++
        // Snapshot this cut leg's frames + finalize its duration BEFORE the reset (D1 — a cut leg's frames
        // survive for diagnosis), mirroring the transparent-retry bookkeeping.
        currentEnv.ctx.commitAttemptSseEvents()
        currentEnv.ctx.finalizeCurrentAttemptDuration()
        opts.onAttemptReset?.()
        currentEnv.ctx.resetRepairOutcomesForAttempt()
        currentEnv.ctx.resetSseEvents()
        // Build the continuation upstream body: [original] + [assistant = committed prefix] + [user =
        // message]. `ledger.snapshot()` already excludes thinking (extractor) — upstream rejects thinking
        // as a prefix (ADR D3). The synthetic turns are faithfully recorded as real wire bytes on the
        // upstreamRequest track; createDriverRecordingPort tags every continuation-role dispatch through
        // the track's side-channel extensions, never by mutating this body or the upstream-original response.
        const continuationBody = continuation.buildRequest(continuationOriginalBody, ledger.snapshot(), continuation.message)
        const contEnv = currentEnv.with({ body: continuationBody })
        try {
          const parent = generation?.bindings.get(current)
          if (!parent) currentEnv.ctx.recordAttemptFailure({ willRetry: true, nextStrategy: "continuation" })
          const coordinator = parent?.coordinator ?? createDriverCoordinator(deps, contEnv)
          const continued = parent ? await coordinator.runContinuation(parent.candidate, "continuation", contEnv) : await coordinator.runPrimary()
          generation?.bind(coordinator, continued)
          currentEnv.ctx.selectGenerationWinner(continued.candidate, continued.dispatch)
          if (allocationPort?.wireState) {
            const leg = await allocationPort.beginLeg("continuation", {
              candidateId: String(continued.candidate),
              dispatchId: String(continued.dispatch),
            })
            if (!leg.ok) return ownerFailureOutcome(leg, "begin-leg", env)
          }
          current = continued.upstream
          currentEnv = continued.env
          // This next leg's frames re-index by the blocks already delivered (C3: wire count) and drop the
          // leg's duplicate message_start.
          continuationOffset = wireDeliveredBlocks
          onContinuationLeg = true
          continue
        } catch (continuationDispatchError) {
          // Continuation is BEST-EFFORT ("尽力救回完整响应"): if OPENING the continuation exchange fails
          // (e.g. the generation candidate budget is exhausted on a high max_retries config — the candidate
          // cap is not the continuation budget), degrade GRACEFULLY rather than crash the request. The
          // committed prefix is already on the client wire, so fall through to the degrade return below,
          // which emits `continuation-exhausted` (continuationCount was already incremented).
          consola.debug(
            `[driver] continuation dispatch failed, degrading to continuation-exhausted: ${continuationDispatchError instanceof Error ? continuationDispatchError.message : String(continuationDispatchError)}`,
          )
        }
      }

      // Exhausted / non-retryable → surface the error (truncation synthesizes one) for the
      // handler to classify + write its protocol error frame (unchanged from the live path). The
      // final failed attempt's frames stay at the top-level slot (no per-attempt snapshot).
      // M1: close the still-open anchor (if injected) BEFORE the failure return so the client's block
      // structure is balanced when the handler appends its error frame.
      // 穷尽/非重试：最终失败 attempt 也 finalize duration，供终端汇总行 last（截断路径无 setter）。
      currentEnv.ctx.finalizeCurrentAttemptDuration()
      const closeOutcome = await closeAnchorViaOwner("terminal")
      if (closeOutcome && closeOutcome.kind !== "stream-error") return closeOutcome
      // Block-level degrade (P0) / continuation-exhausted (spec §5.3): a boundary block was ALREADY
      // committed live, then the stream truncated (un-retryable). If continuation was ATTEMPTED but ran out
      // of budget (or the final continuation leg was itself cut), this is `continuation-exhausted` — distinct
      // from `partial-degrade` (continuation never fired: gate off / no builder / interactive tool_use / cut
      // was not a truncation) and from `exhausted` (terminal-only path, committed nothing). Lets observability
      // tell "continuation fired but didn't save it" from "never continued".
      const committedDegrade = continuationCount > 0 ? "continuation-exhausted" : "partial-degrade"
      const degradeOutcome = committedAny ? committedDegrade : "exhausted"
      notifyBufferedResolve?.(degradeOutcome, attempt, { vendor, ...(continuationCount > 0 && { continuationRetries: continuationCount }) })
      return (
        closeOutcome
        ?? streamErrorOutcome(thrown ?? new Error("upstream stream truncated: closed without message_stop"), env, thrown === null || thrown === undefined)
      )
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
