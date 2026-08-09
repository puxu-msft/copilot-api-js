/**
 * v4 pipeline — stage / driver / retry / transport contracts.
 *
 * The machinery layer around the thin {@link RequestEnvelope}: stage signatures,
 * the driver orchestration contract, the error-driven retry strategy interface
 * (env-based — see docs/v4/03-spec/retry-transport.md §2), and the pure transport
 * send contract.
 *
 * Note on naming: the envelope-based {@link RetryStrategy} here is the orchestration
 * contract. Format-native payload strategies own their generic contract in
 * `~/lib/request/retry-types` and enter the driver through the payload adapter.
 */

import type {
  //
  DispatchHandle,
  OperationKind,
} from "~/lib/context/model-operation-record"
import type {
  //
  EffectiveRequest,
  InboundQuery,
  WireRequest,
} from "~/lib/context/types"
import type { ApiError } from "~/lib/error"
import type { HistoryReservation } from "~/lib/history/worker/admission"
import type { RouteOverride } from "~/lib/models/normalize-id"
import type {
  //
  BaseStreamAccumulator,
  SseFrame,
  StreamErrorKind,
} from "~/lib/stream"
import type { ParsedSseFrame } from "~/lib/transport/parsed-sse-frame"

// `import type` — erased at runtime, so this does NOT create a runtime cycle with
// rewrite-registry.ts (which imports `UpstreamFrame` from here). FrameAction is only
// used in the dry-run `onRewriteAction` hook signature ([[type-only-import-breaks-visual-cycle]]).
import type { BufferedFlushContext } from "./buffered-flush"
import type {
  //
  CanonicalBlock,
  CommittedBlocksLedger,
} from "./committed-blocks-ledger"
import type {
  //
  ClientFormat,
  RequestEnvelope,
  ResolvedModel,
  UpstreamEndpoint,
} from "./envelope"
import type { FrameAction } from "./rewrite-registry"

export type { BufferedFlushContext } from "./buffered-flush"
export type { OwnerOperation } from "./owner-operation"

// ============================================================================
// SSE frames + upstream stream
// ============================================================================

/** Semantic SSE fields exposed to upstream observers, rewrites, hooks, and codecs. */
export type UpstreamFrame = SseFrame

/** Transport-owned parsed frame entering the response processor before semantic projection. */
export type TransportUpstreamFrame = ParsedSseFrame | UpstreamFrame

/** One SSE frame flowing to the client, post-rewrite/translate (S5→S7). */
export type ClientFrame = SseFrame

export interface DispatchDisposalResult {
  quiesced: true
  connectionReusable: boolean
  detail?: string
}

/** Lifecycle owner for one physical upstream dispatch. */
export interface UpstreamDispatchLifecycle {
  /** Cooperative cancellation; returns immediately. */
  cancel(reason?: string): void
  /** Idempotent force-disposal barrier; no local frame/header callback can fire after resolve. */
  dispose(reason?: string): Promise<DispatchDisposalResult>
  /** Resolves on natural completion or disposal. */
  quiesced: Promise<void>
}

/**
 * The result of a single upstream exchange (S4 output). Streaming responses
 * expose `frames`; non-streaming responses expose `nonStream`. `headers`
 * carries the upstream HTTP response headers for capture (Retry-After, quota).
 */
export interface UpstreamStream<Frame extends TransportUpstreamFrame = TransportUpstreamFrame> {
  frames: AsyncIterable<Frame>
  /** Parsed JSON body for non-streaming responses (undefined when streaming). */
  nonStream?: unknown
  headers: Headers
  /** Real transports always provide this; hook mocks may omit it during the migration. */
  lifecycle?: UpstreamDispatchLifecycle
}

// ============================================================================
// Wire request + transport
// ============================================================================

/**
 * The final HTTP request bytes for one attempt, produced by `prepareWire(env)`
 * (the per-attempt "last-mile" header/body trim). Carries the actual wire shape
 * the transport sends: `{ url, headers, body, stream }`.
 *
 * Does NOT write back to `env.body` — `env.body` stays the rewritten logical
 * request (effectiveRequest); this is the outboundRequest (the two history tracks).
 *
 * Distinct from the history-side `WireRequest` in `~/lib/context/types`, which is
 * a structured per-attempt *record snapshot* (`{ model, messages, payload, headers,
 * format }`) sitting alongside `EffectiveRequest`/`ResponseData` in `Attempt`. That
 * one is the recorded view; this `PreparedRequest` is the actual bytes — distinct
 * concepts, no longer sharing a name (R1 resolved by renaming the transport side,
 * the zero-consumer newcomer, leaving history's symmetric triple intact).
 *
 * P2 target: the driver derives the history snapshot FROM this `PreparedRequest` +
 * env (model←env, messages/payload←body, format←env, headers←headers), removing the
 * handlers' manual `setAttemptWireRequest` construction (envelope-driver.md §4
 * auto-sampling, 06-inherited-issues DI-3).
 */
export interface PreparedRequest {
  url: string
  headers: Headers
  body: unknown
  stream: boolean
}

/**
 * Scheduler-owned controls for ONE physical transport dispatch.
 *
 * `dispatch` is the canonical ownership link: every transport-level observation is attributed to THIS handle, never to whatever attempt happens to be "current" on the request context.
 * Ambient attribution is wrong the moment two dispatches overlap — hedged candidates and buffered retry both do exactly that — and the failure is silent, because a misattributed diagnostic still lands on a real attempt.
 *
 * It is required, and so is the options bag itself, so that a new dispatch site cannot compile without deciding whose dispatch it is.
 */
export interface TransportDispatchOptions {
  /** Canonical owner of this dispatch; every diagnostic recorded below is attributed here. */
  dispatch: DispatchHandle
  /** Skip the Responses WS-first choice for an explicit `ws-fallback` HTTP dispatch. */
  forceHttp?: boolean
  /** Candidate/dispatch-local cancellation, independent from request-level lifecycle signals. */
  signal?: AbortSignal
}

/**
 * Pure send/receive, format-agnostic. Extracted from the three clients' shared
 * skeleton (docs/v4/02-current-state.md §6.1): token check → combine signals →
 * upstreamFetch (undici + keepalive dispatcher) → captureHttpHeaders → throw
 * HTTPError on !ok → stream ? SSE iterable : json. The adaptive rate-limiter
 * wraps this at the call site (kept, see retry-transport.md §5).
 */
export interface Transport {
  send(wire: PreparedRequest, env: RequestEnvelope, options: TransportDispatchOptions): Promise<UpstreamStream>
}

export type PhysicalTransportResponse =
  | {
      kind: "stream"
      upstream: UpstreamStream & { lifecycle: UpstreamDispatchLifecycle }
      lifecycle: UpstreamDispatchLifecycle
    }
  | { kind: "json"; body: unknown; headers: Headers; lifecycle: UpstreamDispatchLifecycle }
  | { kind: "fallback-before-first-event"; error: unknown; lifecycle: UpstreamDispatchLifecycle }
  | { kind: "failed-open"; error: unknown; lifecycle: UpstreamDispatchLifecycle }

/** Mandatory physical ownership contract consumed by the generation dispatch scheduler. */
export interface PhysicalTransport {
  open(wire: PreparedRequest, env: RequestEnvelope, options: TransportDispatchOptions): Promise<PhysicalTransportResponse>
}

// ============================================================================
// Error-driven retry strategy (env-based)
// ============================================================================

/**
 * An error-driven retry strategy. Unlike the payload-oriented `RetryStrategy<TPayload>`,
 * `handle` receives and returns the **envelope** — it mutates one layer of env
 * (prepareHints / body / target), and the next loop turn re-derives the wire via
 * `prepareWire(env)`. This unifies "what to fix + where to re-enter" (see
 * retry-transport.md §2.2 for the per-strategy env layer).
 */
export interface RetryStrategy {
  readonly name: string
  /** Whether this strategy can handle the classified error. */
  canHandle(error: ApiError): boolean
  /** Decide the next action (retry with a modified env, or abort). */
  handle(error: ApiError, env: RequestEnvelope): Promise<RetryAction>
  /**
   * Commit learning after a retry produced by THIS strategy ultimately succeeded.
   * `meta` is the `RetryAction.meta` carried by the **budget-accepted** retry that
   * produced the successful env (the driver threads it post-gate, so a
   * budget-rejected retry's meta never reaches here — C0-② / RFC §11.2). The
   * adapter forwards it into the payload strategy `ResolvedContext.meta`, where
   * `unsupported-beta-retry.onResolved` reads `meta.probedBetas` to fixate the
   * located betas into the negotiation cache.
   */
  onResolved?(env: RequestEnvelope, meta?: Record<string, unknown>): void | Promise<void>
}

/**
 * The outcome of a strategy's `handle`. `retry` carries the modified envelope
 * for the next attempt; `learning` retries draw from a separate budget (see
 * retry-transport.md §2 / the driver learning-retry budget).
 *
 * `meta` is opaque per-retry diagnostic data (the payload strategy `RetryAction.meta` — e.g.
 * `sanitization` / `probedBetas` / `strippedBetas`). The driver
 * captures it loop-local **only after the budget gate accepts the retry**, then
 * routes it to the handler's `onMeta` sink and to the owning strategy's
 * `onResolved` — so a budget-rejected retry never emits phantom pipeline-info
 * (C0-② / RFC §11.2). The adapter sets it from the legacy action instead of the
 * old pre-gate immediate `onMeta` call.
 */
export type RetryAction =
  | { kind: "retry"; env: RequestEnvelope; waitMs?: number; learning?: boolean; meta?: Record<string, unknown> }
  | { kind: "abort"; error: ApiError }

// ============================================================================
// Route decision
// ============================================================================

/**
 * S2 routing outcome (`router.decideRoute` — ADR 2026-07-11, extracted from the codecs).
 * Unifies the 4 scattered passthrough checks + Gemini's no-gate translate
 * (docs/v4/03-spec/codec.md §2).
 *
 * The `translate` variant omits a `from` field: the source format is always
 * available as `env.clientFormat`, so carrying it here would duplicate state.
 * (docs/v4/01-architecture.md §6 shows a `from`-bearing variant; the router — the
 * authoritative decideRoute site — omits it, and that is the version used here.)
 */
export type RouteDecision =
  | { kind: "passthrough"; endpoint: UpstreamEndpoint }
  | { kind: "translate"; to: UpstreamEndpoint }
  | { kind: "reject"; status: 400; reason: string }

// ============================================================================
// Stage signatures
// ============================================================================

/** Request-side stage: linear, one-shot. */
export type RequestStage = (env: RequestEnvelope) => Promise<RequestEnvelope>

/** Response-side stage: streaming transform over SSE frames. */
export type ResponseStage = (frames: AsyncIterable<UpstreamFrame>, env: RequestEnvelope) => AsyncIterable<ClientFrame>

/** S4 special: env → upstream stream (contains the retry loop, see retry-transport.md). */
export type ExchangeStage = (env: RequestEnvelope) => Promise<UpstreamStream>

// ============================================================================
// Driver
// ============================================================================

/**
 * The inbound HTTP request abstraction handed to S1 (`codec.parse`). Thin: it
 * carries only what parse needs — the already-JSON-parsed body, inbound headers
 * (for capture + forwarding), an optional Azure deployment model override, and
 * the downstream client-disconnect signal (folded into the upstream fetch
 * signal at S4). Fields are added as parse needs them (P2).
 */
export interface RawHttpRequest {
  readonly body: unknown
  readonly headers: Headers
  /** Inbound HTTP method (codec.parse forwards it to `manager.create`). */
  readonly method?: string
  /** Inbound URL path (codec.parse forwards it to `manager.create` as path + rawPath). */
  readonly path?: string
  /**
   * Client inbound query string + the filtered form to forward upstream.
   * The route computes `forwarded` at handler entry (via `filterUpstreamQuery`
   * gated on `state.forwardClientQuery`); codec.parse forwards this to
   * `manager.create` so the transport adapter can append `forwarded` to the
   * upstream URL. Absent when the inbound request carried no query.
   */
  readonly query?: InboundQuery
  /** Model override injected by Azure deployment routing (codec.parse reads it). */
  readonly modelOverride?: string
  /**
   * Whether the client asked for a streaming response, when that is NOT derivable from `body`.
   * Gemini's stream flag comes from the URL (`streamGenerateContent` vs `generateContent`), not the
   * request body, so the route passes it here for the gemini codec's S1b `translateInbound` (RFC
   * 2026-07-14 §4 — parse now keeps the native `contents[]` body, which has no stream field). Other
   * codecs read stream off `body` and ignore this.
   */
  readonly stream?: boolean
  /**
   * The client's raw inbound body for the history snapshot, when it differs from
   * `body`. The route applies the async, non-idempotent system-prompt injection
   * to `body` BEFORE `codec.parse` (parse is sync — P2.2-D3); it passes the
   * pre-injection client body here so parse records the inboundRequest as what
   * the client actually sent (not the server-modified wire body). Defaults to
   * `body` when omitted (no system-prompt injection happened).
   */
  readonly originalBodyForHistory?: unknown
  /**
   * Model resolution computed by the route BEFORE the sync parse, at the legacy
   * timing point (before the async system-prompt's `applyConfigToState` config
   * reload — P2.2-D3). Supplying it makes parse use this exact resolution rather
   * than re-resolving post-reload, so a config reload (e.g. `disabled_models`) that
   * happens during system-prompt cannot shift the model lookup relative to the
   * legacy handler. `model: undefined` is a valid value (unknown gpt-* fallback).
   */
  readonly preResolved?: { name: string; model: ResolvedModel | undefined; routeOverride?: RouteOverride }
  /** Non-HTTP operation identity supplied by transport entry points such as Responses WS. */
  readonly historyReservation?: HistoryReservation
  readonly operationIdentity?: {
    readonly kind: OperationKind
    readonly connectionId?: string
    readonly responseCreateId?: string
    readonly previousResponseId?: string | null
  }
  /** Downstream client-disconnect signal, folded into the upstream fetch signal. */
  readonly clientAbortSignal?: AbortSignal
}

export type OwnerFailureReason = "client-gone" | "session-terminating" | "wire-torn"
export type OwnerResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; reason: "client-gone"; committed: boolean }>
  | Readonly<{ ok: false; reason: "session-terminating" | "wire-torn"; committed: false }>

export type WireWriteSpec =
  | Readonly<{ kind: "real"; frame: ClientFrame }>
  | Readonly<{ kind: "anchor"; frame: ClientFrame }>
  | Readonly<{ kind: "keepalive"; frame: ClientFrame }>

export interface WireEnvelopeFactory {
  real(frame: ClientFrame): WireWriteSpec
  anchor(frame: ClientFrame): WireWriteSpec
  keepalive(frame: ClientFrame): WireWriteSpec
}

export interface RecoveryBatchBuild {
  readonly specs: ReadonlyArray<WireWriteSpec>
  /** Owner-only callback: invoked inside the serializer if an anchor is actually open. */
  readonly closeOpenAnchorBefore?: (index: number, envelope: Pick<WireEnvelopeFactory, "anchor">) => WireWriteSpec
}

export interface WireBlockAllocationPort {
  readonly wireState?: GenerationWireState
  allocateAndWriteAnchor(build: (ctx: { wireIndex: number; envelope: WireEnvelopeFactory }) => ReadonlyArray<WireWriteSpec>): Promise<OwnerResult<number>>
  withAllocatedRealBlock(
    upstreamIndex: number,
    build: (ctx: { mapping: WireBlockMapping; envelope: WireEnvelopeFactory }) => ReadonlyArray<WireWriteSpec>,
  ): Promise<OwnerResult<WireBlockMapping>>
  beginLeg(kind: "primary" | "continuation" | "recovery", source: LegSource): Promise<OwnerResult<LegToken>>
  /** Stages a completed recovery's client-shaped frames, then publishes the whole batch at one C9 point. */
  publishRecoveryBatch(source: LegSource, build: (envelope: WireEnvelopeFactory) => RecoveryBatchBuild): Promise<OwnerResult<"published">>
  closeOpenAnchor(
    buildStop: (index: number, envelope: WireEnvelopeFactory) => WireWriteSpec,
    mode: "before-real" | "terminal",
  ): Promise<OwnerResult<"closed" | "none">>
  writeBlockFrame(leg: LegToken, upstreamIndex: number, frame: ClientFrame): Promise<OwnerResult<"written">>
}

/** Per-call hooks for {@link PipelineDriver.runResponse}. */
export interface RunResponseOpts {
  /** `publish` is the normal client-delivery path; `evaluate` is an isolated candidate-only drain. */
  responseMode?: "publish" | "evaluate"
  /** Explicit generation owner for a decorated live sink; never register wrapper objects as owners. */
  wireAllocationPort?: WireBlockAllocationPort
  /**
   * Invoked at the response loop top with each UPSTREAM-ORIGINAL frame (raw,
   * verbatim — BEFORE the S5 rewrite chain), at the same point/condition the driver
   * samples `upstreamSse` (the `[DONE]` sentinel is skipped). Lets a handler keep
   * its upstream-side work (accumulate → history `outboundResponse`, repetition,
   * progress, error diagnostics) on the raw frames while the driver yields the
   * rewritten ones for forwarding (RFC §4.A1 — preserves the upstream-original
   * accumulate when the response rewrites move into the driver).
   */
  onUpstreamFrame?: (frame: UpstreamFrame) => void
  /**
   * owns-sink only (consumed by `runResponseSink`, ignored by the generator
   * `runResponse`): a post-S6-render, pre-write per-frame hook. The COUNTERPART of
   * `onUpstreamFrame` (pre-rewrite, observe-only) — where the upstream side observes raw
   * frames for the upstream-original track, the forwarded side TRANSFORMS each rendered
   * frame for the client. The handler does its rendered-frame-side work (accumulate → the
   * terminal `complete` data, progress) as a side effect AND returns the frame to forward,
   * e.g. CC tool-name restore (forwarded-only: history keeps the upstream names via the
   * driver's raw upstream-track sampling, so the restore must NOT touch that track).
   * Applied AFTER the `[DONE]` sentinel is dropped, so it never sees `[DONE]`. Anthropic
   * omits it (its restore is an S5 rewrite; it accumulates raw via `onUpstreamFrame`).
   * Returns `undefined` to SKIP the frame entirely (not written, not forward-sampled) —
   * used by Responses for empty/unparseable frames that the legacy loop dropped before
   * forwarding; CC always returns a frame.
   */
  onRenderedFrame?: (frame: ClientFrame) => ClientFrame | undefined
  /**
   * owns-sink only (`runResponseSink`): early-stop predicate evaluated AFTER each frame is
   * written. Returning `true` breaks the drain loop and settles `complete` — the format's
   * terminal-frame signal (Responses WS stops after `response.completed`/`failed`/`incomplete`/
   * `error` so a trailing frame or a stalled-without-closing upstream is never read past). The
   * break runs the generator's `finally` (flushChain) like any consumer close; for Responses the
   * S5 chain has no buffering rewrite so nothing is lost. Omitted = drain the upstream fully
   * (Anthropic / CC / Responses-HTTP). The frame is the just-written one (post-`onRenderedFrame`).
   */
  stopAfterFrame?: (frame: ClientFrame) => boolean
  /**
   * Dry-run only (pipeline-dry-run-inspector.md §4 T1): yield the S5-rewritten frames
   * VERBATIM instead of running `codec.renderResponse` (S6). For a format whose render is
   * NON-identity (CC-via-responses / Responses fallback / Gemini), this exposes the S5
   * output before the S6 translation — what the rewrite chain actually produced. Covers
   * BOTH yield points (the per-frame loop AND the stream-end `flushChain` drain), so
   * stream-end buffered frames aren't rendered while loop-body frames aren't (RFC §11 red
   * line). Anthropic's render is identity, so this is a no-op there.
   */
  skipRender?: boolean
  /**
   * Dry-run only (§4 T2): sample each response rewrite's per-frame {@link FrameAction} as
   * the S5 chain runs (`(rewriteName, frameIndex, action)`, frameIndex = upstream frame
   * ordinal). Production omits it → zero overhead. Sampled only on the per-frame loop, NOT
   * the stream-end `flushChain` re-threading (frameActions = per-upstream-frame transform
   * actions; the flushed frames are reported separately by the inspector).
   */
  onRewriteAction?: (rewriteName: string, frameIndex: number, action: FrameAction) => void
  /**
   * Branch-local protocol finish callback, invoked only after a natural upstream drain and after
   * S5 rewrite buffers flush. It returns already client-shaped closing frames plus the protocol
   * completeness verdict. The processor yields `frames` through the normal post-render/sink path;
   * thrown upstream errors do not invoke it.
   */
  finishResponse?: (rendererFrames: ReadonlyArray<ClientFrame>) => ResponseFinishResult
  /** Internal observer used by the sink driver to return the processor verdict without re-running finish. */
  onFinishResolved?: (result: ResponseFinishResult) => void
}

/** Protocol completion classification produced at the response processor's single finish boundary. */
export type ResponseFinishResult =
  | { kind: "complete"; frames: ReadonlyArray<ClientFrame> }
  | { kind: "valid-terminal-without-boundary"; frames: ReadonlyArray<ClientFrame>; terminal: string }
  | { kind: "truncated"; frames: ReadonlyArray<ClientFrame>; reason: string }
  | { kind: "terminal-failure"; frames: ReadonlyArray<ClientFrame>; error: unknown }

/**
 * Anthropic-supplied hooks for the buffered empty-text keepalive ANCHOR (spec
 * 2026-07-08-buffered-keepalive-empty-text-anchor §3.2, layering H2). The
 * format-agnostic driver only ORCHESTRATES (lazy-inject on idle, freeze + close-off +
 * remap on commit); the Anthropic handler supplies the format-specific frames + the
 * message_start predicate + the block-index remap. `ping` / `content_delta` handlers
 * omit `anchor` entirely, so the driver's anchor path is inert for them.
 */
export interface AnchorHooks {
  /** Is this rendered client frame the `message_start`? (drives the driver's capture + commit-time dedup). */
  isMessageStart: (frame: ClientFrame) => boolean
  /** Is this rendered client frame a real `content_block_start`? (drives the sequential anchor close-before-real-block). */
  isContentBlockStart: (frame: ClientFrame) => boolean
  /** Build the synthetic anchor `content_block_start{type:"text", text:""}` at its allocated wire index. */
  startFrame: (index: number) => ClientFrame
  /** Build the synthetic anchor `content_block_stop` at its allocated wire index. */
  stopFrame: (index: number) => ClientFrame
  /** Build the empty `text_delta` anchor keepalive frame at its allocated wire index. */
  deltaFrame: (index: number) => ClientFrame
  /**
   * Fabricate a `message_start` envelope (fake id + zeroed usage) for when the upstream stalls before
   * emitting its own real `message_start`, so the client stream is well-formed enough to open a block.
   * Optional: only the empty_text buffered path supplies it (P3 injector consumes it); the driver's
   * anchor path stays inert when omitted.
   */
  syntheticMessageStart?: (model: string, reqId: string) => ClientFrame
  /**
   * Shift a real `content_block_*` frame's index by `offset` (the anchor reserved index 0, so all
   * real blocks flush at +1). Non-block frames (message_delta / message_stop / non-JSON) pass through.
   */
  remap: (frame: ClientFrame, offset: number) => ClientFrame
}

/**
 * Continuation-retry hooks (spec 2026-07-22 §4-§5, ADR D3) — everything the driver's continuation branch
 * needs, resolved by the handler so the driver stays format-agnostic. The handler supplies these ONLY when
 * continuation is enabled AND a per-format builder exists, so `opts.continuation !== undefined` IS the gate.
 */
export interface ContinuationHooks {
  /** Per-vendor gate (resolved from config). When false the driver never takes the continuation branch. */
  enabled: boolean
  /** The synthetic user-turn text ("network issue. please continue" default). */
  message: string
  /** Is this rendered frame the `message_start`? — a continuation leg's duplicate is dropped. */
  isMessageStart: (frame: ClientFrame) => boolean
  /** Is this rendered frame a `content_block_start`? — the driver counts wire-delivered blocks for the offset. */
  isContentBlockStart: (frame: ClientFrame) => boolean
  /** Shift a `content_block_*` frame's index by `offset` (continuation blocks re-indexed by the wire-delivered count). */
  remap: (frame: ClientFrame, offset: number) => ClientFrame
  /** Build the continuation upstream body: `[original] + [assistant = committed] + [user = message]`. */
  buildRequest: (originalBody: unknown, committed: ReadonlyArray<CanonicalBlock>, message: string) => unknown
}

/**
 * The mutable buffered empty-text keepalive ANCHOR state — the single source of truth shared across
 * the cross-handler injector, the driver's buffered path, and the live-path reconciliation (spec
 * 2026-07-08-buffered-keepalive-empty-text-anchor §10.1.5 H1). Today the driver owns/creates it
 * internally; the upcoming "injector moves to the handler" refactor threads a handler-owned instance
 * in via {@link RunBufferedOpts.anchorState} so both sides observe the SAME injection/close state
 * (no torn snapshot — §3.3 B1 flips `injected` synchronously before the first sink write).
 */
declare const legTokenBrand: unique symbol

/** Immutable identity of one upstream generation leg. */
export type LegToken = string & { readonly [legTokenBrand]: true }

/** Immutable handle mapping one upstream block onto its generation-wide wire index. */
export interface WireBlockMapping {
  readonly wireIndex: number
  readonly upstreamIndex: number
  readonly leg: LegToken
  remap(frame: ClientFrame): ClientFrame
}

export interface WireIndexReservation<Value> {
  readonly value: Value
  commit(): void
  rollback(): void
}

export interface LegSource {
  readonly candidateId: string
  readonly dispatchId: string
}

/** Shared generation state injected into the delivery owner; callers never mutate its registries. */
export interface GenerationWireState {
  readonly allocator: GenerationWireIndexAllocator
  readonly mappings: Map<LegToken, Map<number, WireBlockMapping>>
  readonly legSources: Map<LegToken, LegSource>
  activeLeg?: Readonly<{ token: LegToken; kind: "primary" | "continuation" | "recovery"; source: LegSource }>
  openAnchorIndex?: number
}

export interface GenerationWireIndexAllocator {
  /** Peek the wire index the NEXT anchor block will occupy. */
  nextAnchorIndex: () => number
  /** Peek the wire index the NEXT real block will occupy. */
  nextRealIndex: () => number
  /** Legacy split-phase commit retained until P3M migrates all old call sites. */
  onAnchorOpen: () => void
  /** Legacy split-phase commit retained until P3M migrates all old call sites. */
  onRealBlockOpen: () => void
  /** Begin one upstream round. The delivery owner serializes this synchronous primitive. */
  beginLeg: (kind: "primary" | "continuation" | "recovery", source: { candidateId: string; dispatchId: string }) => LegToken
  /** Atomically allocate and commit one synthetic anchor index. */
  allocateAnchor: () => number
  /** Atomically allocate and commit one real block mapping on the active leg. */
  allocateRealBlock: (upstreamIndex: number) => WireBlockMapping
  /** Low-level reservation used by the delivery owner's pre-write commit protocol. */
  reserveAnchor: () => WireIndexReservation<number>
  /** Low-level reservation used by the delivery owner's pre-write commit protocol. */
  reserveRealBlock: (upstreamIndex: number) => WireIndexReservation<WireBlockMapping>
  /** Diagnostic count of allocated synthetic anchors. Never use this as a remap predicate. */
  anchorsOpened: () => number
  /** Resolve the offset from an upstream block index to its allocated wire index. */
  realBlockOffset: (upstreamIndex: number) => number
}

export interface AnchorState {
  /** The required generation-scoped wire-state SSOT shared by every anchor and real-block delivery leg. */
  wireState: GenerationWireState
  /** Any synthetic prelude has been injected onto the forwarded track (message envelope and/or content anchor). */
  injected: boolean
  /** The content anchor itself has been injected. Kept separate so enveloped_ping cannot suppress later content escalation. */
  contentAnchorInjected?: boolean
  /** The (real or synthetic) `message_start` has been forwarded — the commit flush skips the buffered copy (H1 dedup). */
  messageStartForwarded: boolean
  /**
   * The injector opened a synthetic anchor `content_block@0` at index 0 — the discriminator between the two
   * injected preludes (spec §10.4 / §10.6):
   *   - `empty_text` (default): TRUE. The injector reserved index 0 with an empty-text anchor block, so the
   *     live reconcile / buffered commit must close it off (`content_block_stop@0`) before the first real
   *     block AND shift every real `content_block_*` +1 around it.
   *   - `enveloped_ping` (experimental): FALSE. The injector wrote ONLY the message_start envelope — no anchor
   *     block, no empty delta — so real blocks pass through at their ORIGINAL index and NO close-off is written.
   * Distinct from {@link anchorClosed} (which tracks whether the `stop@0` was emitted): `anchorBlockOpen` stays
   * TRUE for the whole stream once set (index 0 remains reserved even after the anchor is closed).
   */
  anchorBlockOpen: boolean
  /** The anchor `content_block_start@0` has been closed off by a `content_block_stop@0` (commit / terminal-failure). */
  anchorClosed: boolean
  /** First REAL `message_start` captured on the buffered track; the injector prefers it over a synthetic one ("prefer real, else synthetic"). */
  capturedMessageStart?: ClientFrame
}

/**
 * The terminal resolution label of a buffered-retry generation — the single source of truth
 * for this union, PRODUCED by the driver's buffered sink (emitted through {@link
 * RunBufferedOpts.onBufferedResolve}) and CONSUMED by the vendor-keyed telemetry counter
 * (`~/lib/anthropic/protect-streaming-stats` re-exports THIS type rather than redeclaring it, so
 * the two never drift). Defined here in the format-agnostic pipeline layer — the producer — so the
 * pipeline never has to import the anthropic telemetry module (which would invert the dependency).
 *   - `"success"`:         committed a complete generation (retries > 0 = a save).
 *   - `"exhausted"`:       all retries failed → surfaced as a stream error.
 *   - `"retreated"`:       buffer cap exceeded → retreated to live forwarding.
 *   - `"partial-degrade"`: block-level path only — a boundary block was already committed live,
 *     then the stream truncated (un-retryable). A graceful degrade distinct from `exhausted`.
 *   - `"precontent-recovery-success"` / `"precontent-recovery-exhausted"`: reserved B2 counters for
 *     a fresh dispatch that follows a failure before real content reaches the client.
 */
export type ProtectStreamingOutcome =
  | "success"
  | "exhausted"
  | "retreated"
  | "partial-degrade"
  | "continuation-exhausted"
  | "precontent-recovery-success"
  | "precontent-recovery-exhausted"

/**
 * Options for `runResponseBufferedSink` (L2 — streaming upstream-RST buffered retry,
 * docs/archive/2606-landed-rfcs/streaming-upstream-rst-buffered-retry.md). Extends {@link RunResponseOpts}
 * (the buffered drain still feeds `onUpstreamFrame` / applies `onRenderedFrame` per
 * attempt) with the buffered-retry control surface.
 */
export interface RunBufferedOpts extends RunResponseOpts {
  /**
   * Anthropic synthetic-prelude keepalive anchor hooks (spec 2026-07-08-buffered-keepalive-empty-text-anchor).
   * Present when the handler runs a synthetic-prelude mode (`empty_text` or `enveloped_ping`) on the buffered
   * path; the commit reads `anchorState.anchorBlockOpen` to remap+close-off (`empty_text`) vs only dedup the
   * message_start (`enveloped_ping`). The driver's anchor orchestration is inert when omitted, so `ping` and
   * the live path behave byte-identically to before.
   */
  anchor?: AnchorHooks
  /**
   * The shared {@link AnchorState} the handler owns when it drives the injector (the upcoming
   * "injector moves to the handler" refactor). When supplied, the driver reads/writes THIS instance
   * instead of a locally-created one, so the handler-side injector and the driver's buffered
   * commit/close-off observe the same injection/close state. Omitted during the transition — the
   * driver self-creates an internal `AnchorState`, keeping every existing call site byte-identical.
   */
  anchorState?: AnchorState
  /**
   * Reads the handler's accumulator: did THIS attempt see `message_stop`? The buffered
   * sink commits ONLY on `drained && sawMessageStop()` — a clean drain alone is NOT
   * enough, because Bun delivers a clean upstream RST as a normal `end` (rstCode=0,
   * undetectable; transport/http2-client.ts:169-175). A clean drain WITHOUT message_stop
   * is a truncation → retryable.
   */
  sawMessageStop?: () => boolean
  /**
   * Reads the handler's accumulator: did THIS attempt see a TERMINAL upstream `error` frame
   * (H2 — e.g. `overloaded_error`)? Such a frame is a clean drain WITHOUT `message_stop`, so
   * `sawMessageStop()` alone cannot tell it apart from an RST-truncation. H2 is a terminal
   * upstream decision (NOT a transport cut) → the buffered sink COMMITS it (flushes the buffered
   * upstream error frame to the client and lets the handler fail via `acc.streamError`), mirroring
   * the live path, instead of wastefully retrying it as a truncation. Optional: a caller that does
   * not wire it falls back to the prior "retry every no-message_stop clean drain" behavior.
   */
  sawUpstreamError?: () => boolean
  /** A terminal upstream DECISION that carries no `message_stop`: a contentless refusal. Without it
   *  the driver reads such a stream as truncation and retries/continues a turn whose complete
   *  terminus the refusal rewriter already delivered to the client. */
  sawContentlessRefusal?: () => boolean
  /**
   * Reset ALL handler-side per-attempt accumulators before a retry re-exchanges
   * (acc / local sseEvents / streamState / repetition checker). The driver re-instantiates
   * its own S5 rewrite-chain state per `runResponse` call; this resets the handler's side.
   */
  onAttemptReset?: () => void
  /**
   * Max transport-close / truncation retries (a loop/cost guard, NOT a timeout guard —
   * the client is kept alive by the sink heartbeat). `0` = no retry (buffer + commit only).
   */
  retryCap?: number
  /**
   * Max bytes to buffer before ABANDONING buffering and retreating to LIVE forwarding for the
   * rest of THIS response (an OOM guard against a pathologically huge generation). On retreat the
   * already-buffered frames are flushed and every subsequent frame is written through live — the
   * response then loses L2 protection (a live RST fails as today) and is NOT retried (frames are
   * already forwarded). `0`/undefined = unlimited (no cap). Bytes are estimated from each rendered
   * frame's `data` + `event` string length (a coarse guard, not exact wire bytes).
   */
  bufferCapBytes?: number
  /** Called once if/when the buffer cap is exceeded and the path retreats to live forwarding (telemetry/logging). */
  onRetreat?: () => void
  /**
   * Called exactly once at the buffered path's terminal resolution (NOT on a client-abort, which
   * is the client leaving, not a generation outcome) with the outcome label + the number of
   * re-exchanges consumed (`retries`) + a `meta.vendor` label (injected by the driver from
   * {@link telemetryVendor}, so the handler forwards it into the vendor-keyed telemetry without
   * re-hardcoding it). Drives the L2 hit-rate telemetry (RFC §10):
   *   - `"success"`:         committed a complete generation (retries > 0 = a save).
   *   - `"exhausted"`:       all retries failed → surfaced as a stream error.
   *   - `"retreated"`:       buffer cap exceeded → retreated to live forwarding.
   *   - `"partial-degrade"`: block-level path only — a boundary block was already committed live,
   *     then the stream truncated (un-retryable, the committed prefix is on the wire). A graceful
   *     degrade distinct from `exhausted` (which committed nothing). Never emitted on the
   *     terminal-only path ({@link commitBoundaries} undefined) — `committedAny` stays false there.
   */
  onBufferedResolve?: (outcome: ProtectStreamingOutcome, retries: number, meta: { vendor: string; continuationRetries?: number }) => void
  /**
   * Block-commit boundary predicate (P0 mechanism floor). When PROVIDED, the buffered sink flushes
   * (commits live) the buffered frames up to and including every frame this returns `true` for,
   * inverting the commit point from "once at the terminal drain" to "at each block boundary". Once
   * a boundary block is committed the retry window closes (`committedAny` → the retry gate tightens
   * to `!committedAny && !retreated`), and a subsequent truncation degrades to `partial-degrade`
   * instead of retrying (the committed prefix is un-retryable — already on the wire).
   *
   * UNDEFINED (default) = terminal-only = the legacy whole-response buffered behaviour, byte-for-byte:
   * `committedAny` stays false, the block-commit branch is skipped, and the buffer commits exactly
   * once at the terminal drain (`sawMessageStop` / `sawUpstreamError`). This is the R1 landing gate —
   * an undefined predicate MUST reproduce the whole-response path verbatim (anchor/retreat/terminal
   * commit paths all unchanged).
   */
  commitBoundaries?: (frame: ClientFrame) => boolean
  /**
   * Continuation-retry committed-blocks ledger (spec 2026-07-22 §4.2). When PROVIDED alongside
   * {@link extractCommittedBlocks}, the driver feeds each block-level commit boundary's frames into the
   * ledger (via the extractor) as the canonical "already-delivered prefix" — the data source a later
   * mid-stream-cut continuation replays as a synthetic assistant turn. The driver both FEEDS this ledger
   * (at each boundary) and READS `snapshot()` when it fires the continuation branch, so the same instance
   * is threaded here. The ledger is cumulative across retry attempts (`onAttemptReset` must NOT clear it).
   * UNDEFINED = no continuation ledger (Gemini / terminal-only / continuation disabled) — no feeding, and
   * the driver's continuation branch is never taken. Format-agnostic: the driver only calls the extractor
   * + `recordCommitted`; all Anthropic/CC/Responses block-reconstruction lives in the extractor.
   */
  committedBlocksLedger?: CommittedBlocksLedger
  /**
   * Format-specific projection from a commit boundary's committed frames to canonical blocks (spec
   * 2026-07-22 §4.2). Paired with {@link committedBlocksLedger} — the driver calls it at each block-level
   * commit with the just-committed buffer and records the result into the ledger. Only meaningful when a
   * ledger is supplied; the two are wired together by the handler (e.g. `extractAnthropicCommittedBlocks`).
   */
  extractCommittedBlocks?: (frames: ReadonlyArray<ClientFrame>) => Array<CanonicalBlock>
  /**
   * Continuation-retry seam (spec 2026-07-22 §4-§5, ADR D3). When present ALONGSIDE
   * {@link committedBlocksLedger} + {@link extractCommittedBlocks}, a mid-stream cut AFTER a committed
   * block runs a synthetic continuation exchange (`[original body] + [assistant = committed] + [user =
   * message]`) instead of degrading — the continuation frames are stitched onto the SAME client stream
   * (its duplicate `message_start` dropped, its blocks re-indexed by the wire-delivered block count).
   * Format-agnostic: all format knowledge lives in the hooks the handler supplies. Undefined = no
   * continuation (Gemini / disabled / non-ledger path) — the driver's continuation branch is never taken.
   */
  continuation?: ContinuationHooks
  /**
   * Candidate-hosted buffered-flush transform seam (spec 2026-07-14-responses-buffered-block-merge §4,
   * 2026-07-19 重接地). Same shape/lifecycle as {@link commitBoundaries} — a candidate-supplied option the
   * driver merges in via `currentCandidateResponseOpts` and calls at EVERY flush (block-boundary,
   * terminal-drain, and retreat) immediately before writing, with its RETURN VALUE replacing the raw
   * buffer. The driver interprets no format semantics — it only orchestrates the call + the `cause`
   * discriminant. UNDEFINED (default) = every flush writes the raw buffer verbatim, byte-identical to
   * before this seam existed (R1 landing gate) — CC/Anthropic never populate this, so they are unaffected.
   * Per-attempt state lives entirely on the candidate side (a fresh candidate session per retry/recovery
   * gives a fresh closure) — the driver has no reset hook to call for this seam.
   */
  transformBufferedFlush?: (frames: ReadonlyArray<ClientFrame>, ctx: BufferedFlushContext) => ReadonlyArray<ClientFrame>
  /**
   * Vendor label the driver injects into {@link onBufferedResolve}'s `meta.vendor` (e.g.
   * `"anthropic"` / `"responses"` / `"chat_completions"` / `"responses_ws"`). Lets the handlers
   * forward one vendor-keyed telemetry sink without each re-hardcoding its own vendor string
   * (frozen contract — the driver owns the injection point). Omitted → `meta.vendor` falls back to
   * `"unknown"`.
   */
  telemetryVendor?: string
  /**
   * Per-retry env transform applied BEFORE each re-exchange (L2 escalation, RFC §8). Returns a new
   * env (e.g. with `prepareHints.contextEscalation` set to progressively tighter context_management)
   * so the retry's wire compresses the context and finishes faster. Format-agnostic: the driver just
   * threads the returned env into the next `runExchange`; the Anthropic specifics live in the handler.
   * `attempt` is the 1-based retry number. Omitted = no escalation (env unchanged).
   */
  escalate?: (env: RequestEnvelope, attempt: number) => RequestEnvelope
}

// ============================================================================
// owns-the-sink writeout (Stage B — design §3.2/§3.3)
// ============================================================================

/**
 * The driver's abstract client write-out port (Stage B, design §3.3). Kept
 * deliberately THIN — write + serialize only, no business logic — so owns-the-sink
 * doesn't bloat the driver's concerns (the RFC's named Stage-B cost). The route
 * injects a concrete sink (`makeSseSink(stream)` / `makeWsSink(ws)`); tests use
 * `makeArraySink()`; the driver never touches Hono.
 *
 * All writes share ONE internal Promise chain (serialization) so real frames +
 * synthetic heartbeats + error frames never byte-interleave on the wire.
 */
export interface ClientSink {
  /**
   * Write one rendered real client frame. Samples the FORWARDED track (the SSE sink's
   * `onForwarded`, → history `inboundResponse.sseEvents`); the upstream-original track is
   * the driver's (it samples raw frames before the rewrite chain). The heartbeat ping is
   * sampled too (forwarded-only, via the sink's internal timer).
   */
  write(frame: ClientFrame): Promise<void>
  /**
   * Write a handler-injected terminal frame (e.g. the H3 synthesized error frame) straight
   * to the wire — NOT sampled into either track. This is what keeps the H2-sampled /
   * H3-unsampled forwarded-track asymmetry (B0-c): a handler-synthesized error reaches the
   * client but never enters the forwarded diagnostic record. Shares the same serialization
   * chain as {@link write}. Omitted by sinks that have no out-of-band inject (WS/array).
   */
  writeSynthetic?(frame: ClientFrame): Promise<void>
  /**
   * Write a proxy-synthesized KEEPALIVE frame (e.g. the cold-start commit's immediate first ping) to
   * the wire AND sample it into the forwarded track WITH a `synthetic:"keepalive"` marker — so history/
   * UI/logs never mistake a heartbeat for real upstream content. The sink's internal heartbeat timer
   * marks its own pings the same way; this is for keepalives the HANDLER injects out-of-band. Omitted
   * by sinks with no heartbeat (WS/array).
   */
  writeKeepalive?(frame: ClientFrame): Promise<void>
  /**
   * Write a proxy-synthesized FABRICATED `message_start` envelope (fake id + zeroed usage) to the wire
   * AND sample it into the forwarded track WITH a `synthetic:"synthetic-message-start"` marker. The
   * unique keepalive injector writes it ahead of the anchor block when the upstream stalled before ever
   * emitting its own real `message_start` (live pre-response silence, or the buffered pre-message_start
   * window — spec keepalive timeout-safety §10.2). Distinct from {@link writeKeepalive}/{@link writeAnchor}:
   * the fabricated envelope's fake id + usage:0 is a heavier synthetic than a structural anchor frame (an
   * accepted wire/billing divergence — richest-data-flow), so it carries its own marker. Like
   * {@link writeSynthetic} it does NOT touch the open-block state (a message_start opens no content block).
   * Omitted by sinks with no heartbeat (WS/array) — callers fall back to {@link write}.
   */
  writeSyntheticEnvelope?(frame: ClientFrame): Promise<void>
  /**
   * RECOVERABLY stop the currently armed heartbeat timer without closing the sink. A later
   * {@link resumeHeartbeat} after {@link suspendHeartbeat} MUST be able to arm a fresh interval.
   * Freeze alone does not fence a tick that was already queued or whose async write is in flight;
   * recoverable flushes therefore call `suspendHeartbeat()` before freeze. True terminal paths use
   * {@link close} instead. `write` remains usable throughout. Idempotent; a no-op when heartbeat is off.
   */
  freezeHeartbeat?(): void
  /**
   * Suspend heartbeat injection around a recoverable block flush (spec
   * 2026-07-11-block-level-buffered-retry §4.4). Combined with {@link freezeHeartbeat}, this blocks both
   * the armed timer and a tick already queued at the flush boundary; {@link resumeHeartbeat} then starts
   * a fresh interval for the next inter-block idle. Idempotent; a no-op on sinks whose heartbeat is off.
   * Omitted by sinks with no heartbeat timer at all (WS/array).
   */
  suspendHeartbeat?(): void
  /**
   * Resume a {@link suspendHeartbeat}-suspended heartbeat, re-arming a FRESH interval counted from the
   * resume (§4.4). A no-op when not currently suspended (the single live timer is untouched) or on a closed
   * sink (never resurrects a timer). Omitted by sinks with no heartbeat timer (WS/array).
   */
  resumeHeartbeat?(): void
  /**
   * PERMANENTLY stop heartbeat injection; {@link resumeHeartbeat} MUST NOT resurrect it. This closes
   * only the heartbeat lifecycle, not the write port: `write` and {@link writeAnchor} MUST remain usable
   * afterwards because terminal close-off paths close heartbeat before writing their final structural frame
   * (`keepalive-anchor.ts` and the buffered driver's terminal close-off). Idempotent; finalizers MUST call
   * this on every exit so a self-rescheduling timer cannot leak.
   */
  close?(): void
  /** Seal the canonical operation after every real/synthetic client frame has been delivered. */
  finalize?(): void | Promise<void>
}

/**
 * The format-agnostic control-signal result of owns-sink `runResponseSink` (design
 * §3.2, minimality-audit revision + B-cut-over refinement). Carries ONLY the control
 * signal — NO accumulator. Every handler already owns + feeds its own format
 * accumulator (Anthropic via `onUpstreamFrame`, Responses/Gemini by iterating frames),
 * and reads its own terminal business data (usage / stop_reason / truncateResult /
 * responseId / gemini-meta) out-of-band; folding the accumulator back into the outcome
 * would be a net-new coupling + a per-format grab-bag. The handler maps the outcome to
 * `ctx.complete/fail/abort`.
 *
 * Three terminal control signals (B3a, refining B1's single `stream-error`):
 *   - `complete` — the upstream stream drained cleanly (NO throw). A terminal upstream
 *     `error` SSE frame (H2) is part of a CLEAN drain (it's a content frame, not a
 *     throw), so it still yields `complete`; the handler reads its own `acc.streamError`
 *     to map H2 → `ctx.fail`. The driver does NOT inspect the accumulator (it holds none).
 *   - `stream-error` — the upstream iterable (or a `sink.write`) THREW a non-abort error
 *     (H3). Carries the RAW thrown `error` (richest-data-flow): the format handler is the
 *     consumer that classifies it (`classifyStreamError`), shapes its protocol error
 *     frame, logs the disconnect diagnostic, and settles `ctx.fail` — none of which the
 *     format-agnostic driver can do without losing fidelity (a lossy `{type,message}`
 *     summary would drop the error's cause chain + force a re-classification).
 *     `truncated:true` marks the buffered-path variant where the failure is a CLEAN drain
 *     WITHOUT a terminal (a truncation, not a thrown transport error — the synthetic error
 *     carries no meaningful cause chain). The handler routes it to the `truncated`
 *     disconnect label instead of `classifyStreamError` (which would relabel it
 *     `transport-close`), keeping HIGH-1's `kind=truncated` uniform across the plain AND
 *     buffered legs. Absent/false → a real thrown error (`transport-close`).
 *   - `settled-abort` — the throw was a client disconnect (`classifyStreamError ===
 *     "client-abort"`). The downstream stream is dead, so the handler writes ZERO further
 *     bytes and settles `ctx.abort` (B0-d "abort → zero bytes").
 */
export type ResponseFailureSource = "upstream-transport" | "codec-render" | "downstream-sink" | "delivery-owner"

/** Retains the failure that a later codec/flush failure superseded as the client terminal. */
export interface ResponseFailureDiagnostics {
  readonly supersededError: unknown
  readonly supersededSource: Extract<ResponseFailureSource, "upstream-transport" | "codec-render">
  readonly flushError: unknown
}

export type ResponseOutcome =
  | { kind: "complete"; headers: Headers; finish?: ResponseFinishResult }
  | { kind: "stream-error"; error: unknown; source: ResponseFailureSource; diagnostics?: ResponseFailureDiagnostics; truncated?: boolean }
  | { kind: "settled-abort" }
  | { kind: "delivery-finished" }

/**
 * Orchestrates the stage sequence, publishing events + sampling raw data at
 * each stage boundary. Owned by the generation driver after retiring the pre-driver request executor (docs/v4/01-architecture.md §1.3).
 */
export interface PipelineDriver {
  /** Request side: run S1→S4 (S4 contains error-driven retry). */
  runRequest(raw: RawHttpRequest): Promise<DriverRequestResult>
  /** Response side: build the S5→S6→S7 streaming transform chain. */
  runResponse(upstream: UpstreamStream, env: RequestEnvelope, opts?: RunResponseOpts): AsyncIterable<ClientFrame>
  /**
   * Inspect the request side S1→`stopAfter`, NEVER entering S4 (no GHC call). Returns a
   * per-stage envelope snapshot (`body` is `structuredClone`d so later stages don't mutate
   * earlier snapshots) + the S3 per-rewrite `{name, changed}` log. For dry-run / debugging
   * the request-rewrite chain (`docs/archive/2606-landed-rfcs/pipeline-dry-run-inspector.md` §4). Synchronous —
   * S1-S3 have no `await`. Isolation (the global manager touched by `codec.parse`) is the
   * caller's concern, NOT this method's.
   */
  inspectRequest(raw: RawHttpRequest, stopAfter: RequestInspectStage): Promise<RequestInspection>
}

/** Request-side stage to stop {@link PipelineDriver.inspectRequest} after. */
export type RequestInspectStage = "parse" | "translate-inbound" | "translate" | "rewrite-in" | "prepare-wire"

/** Result of {@link PipelineDriver.inspectRequest} — per-stage snapshots up to the stop point. */
export interface RequestInspection {
  /** Where the inspection stopped: the requested stage, or `"reject"` if S2 rejected the route. */
  stoppedAt: RequestInspectStage | "reject"
  /** Present only when `stoppedAt === "reject"`. */
  rejected?: { status: number; reason: string }
  stages: {
    parse?: { clientFormat: string; targetEndpoint?: string; model: unknown; body: unknown }
    /**
     * S1b `codec.translateInbound` output — the client-native body after async inbound processing
     * (gemini `Gemini→CC` + per-format async system-prompt injection). For gemini this is where the
     * `parse` stage's native `contents[]` becomes CC `messages[]` (RFC §3/§4). Absent for a format
     * that omits `translateInbound` (no-op).
     */
    "translate-inbound"?: { body: unknown }
    translate?: { targetEndpoint?: string; body: unknown }
    "rewrite-in"?: { body: unknown; applied: Array<{ name: string; changed: boolean }> }
    /**
     * S4-pre `codec.prepareWire` output — the last-mile wire (url + headers + body + stream)
     * for the FIRST attempt only. `note` flags that reactive retry rewrites (beta-strip /
     * server-tool-strip) — which only fire on an upstream error, never reached in dry-run —
     * are NOT reflected (RFC §11 P1). `prepareWire` is non-pure in real codecs; the caller
     * isolates its side effects (throwaway betaProbe + capturing ctx).
     */
    "prepare-wire"?: { url: string; headers: Record<string, string>; body: unknown; stream: boolean; note: string }
  }
}

/**
 * The result of `runRequest`. `ok:false` covers decideRoute reject / parse
 * failure — no dangling history entry is created (aligns with current
 * messages:165 rejecting before context creation). `reason` is the raw rejection
 * reason; the route/codec shapes the per-format error envelope (the driver does
 * NOT pre-shape it — format differences stay in the codec, codec.md §1).
 */
export type DriverRequestResult =
  | { ok: true; upstream: UpstreamStream; env: RequestEnvelope }
  | { ok: false; rejection: { status: number; reason: string; format: ClientFormat } }

// ============================================================================
// FormatCodec
// ============================================================================

/**
 * Per-request response accumulator handle (the codec's format-specific stream
 * accumulator). Consumed by the HistorySink to rebuild the response double-track
 * (docs/v4/03-spec/codec.md §1, envelope-driver.md §4). Aliases the shared base
 * the existing `create*StreamAccumulator` factories already extend.
 */
export type ResponseAccumulator = BaseStreamAccumulator

/**
 * The classified stream-lifecycle error a codec shapes into a protocol error
 * frame (idle-timeout / shutdown / client-abort / other). Shared classification
 * core is `classifyStreamError` (stream.ts).
 */
export type ClassifiedStreamError = StreamErrorKind

/** Candidate-local S6 renderer. Stateful translators must create one instance per candidate. */
export interface CandidateResponseRenderer {
  renderResponse(frame: UpstreamFrame, env: RequestEnvelope): ClientFrame | Array<ClientFrame>
  flushResponse(env: RequestEnvelope): Array<ClientFrame>
  getStreamMeta?(): unknown
}

/**
 * One format's codec — encapsulates all "this format vs inbound/upstream"
 * differences (docs/v4/03-spec/codec.md §1). The driver consumes it at the
 * stage boundaries; each format implements one (P2.2–P2.6). The driver treats it
 * as an opaque dependency, so P2.1's skeleton + tests use a mock codec.
 */
export interface FormatCodec {
  readonly format: ClientFormat

  /** S1: parse inbound HTTP → envelope (model resolution, body extraction, ctx). SYNC by contract. */
  parse(raw: RawHttpRequest): RequestEnvelope

  /**
   * S1b: async inbound processing that turns the client-NATIVE envelope (post-`parse`, post-
   * `client.inbound` hook) into the driver's outbound-canonical shape — the seam that absorbs
   * per-format async work the route layer used to own (RFC 2026-07-14-symmetric-four-point-hooks
   * §3/§4): gemini's `Gemini→CC` translation, and each format's async system-prompt injection
   * (`processOpenAIMessages`/`processResponsesInstructions`/`processAnthropicSystem`, which await
   * `applyConfigToState`). Runs ONCE per logical request, OUTSIDE the retry loop, AFTER `parse` (so
   * `client.inbound` can still see the native body) and BEFORE S2 route/translate. Optional — a
   * format with no async inbound work omits it (no-op). Distinct from S2 `translateOut` (that is the
   * per-target-endpoint outbound leg, run later). Returns the transformed env.
   */
  translateInbound?(env: RequestEnvelope): Promise<RequestEnvelope>

  /**
   * S2: translate body to the target-endpoint format (passthrough = identity). OPTIONAL since the
   * CellAssembly refactor — the outbound leg (`OUTBOUND_LEGS[targetEndpoint].translateOut`) owns this for
   * every real request (the driver dispatches through `migratedCell(env)`); a codec only implements it as
   * the mock/legacy fallback for a driver-orchestration unit test whose env has no `requestState`.
   */
  translateOut?(env: RequestEnvelope): RequestEnvelope

  /**
   * S4 last-mile: derive the wire (header + body trim) for one attempt from env
   * (consumes prepareHints + negotiation cache + model + config). Idempotent for
   * a given env; does NOT write back to env.body (retry-transport.md §3). OPTIONAL since the CellAssembly
   * refactor — the outbound leg owns it for every real request; a codec implements it only as the
   * mock/legacy fallback (a non-migrated env).
   */
  prepareWire?(env: RequestEnvelope): PreparedRequest

  /**
   * S4 first-attempt only: an async pre-send hook the driver awaits ONCE before the
   * first `prepareWire`, so a codec can rewrite env.body ahead of the initial send
   * (returns the same env unchanged when it declines). Optional — codecs omit it
   * (no-op); the driver runs it unconditionally when present and lets the codec
   * decide. A general extension seam (no codec currently implements it).
   */
  preSend?(env: RequestEnvelope): Promise<RequestEnvelope>

  /** S6: translate one upstream frame back to the client protocol (passthrough = identity). */
  renderResponse(frame: UpstreamFrame, env: RequestEnvelope): ClientFrame | Array<ClientFrame>

  /**
   * Create an isolated response-side renderer for one generation candidate. Codecs whose S6
   * translation is stateful MUST implement this so hedge siblings never share translator ids,
   * block indexes, accumulators, or flush state. Stateless codecs may omit it; the driver then
   * wraps the legacy render method with an empty flush.
   */
  createCandidateRenderer?(env: RequestEnvelope): CandidateResponseRenderer

  /** Fork opaque request-side state for one candidate; real codecs with mutable requestState implement this. */
  createCandidateStateFactory?(env: RequestEnvelope): import("./generation/candidate-state").CandidateStateFactory

  /** S6 non-streaming: translate the whole upstream response back to the client. */
  renderResponseNonStreaming(upstream: unknown, env: RequestEnvelope): unknown

  /** S7: shape a mid-stream lifecycle error into this protocol's error frame. */
  formatError(err: ClassifiedStreamError, env: RequestEnvelope): ClientFrame

  /**
   * observability: the format's response accumulator factory (HistorySink rebuild). Takes the
   * post-route `env` so the accumulator matches the OUTBOUND-leg shape (RFC §4.1, targetEndpoint axis):
   * a translate leg's upstream is a DIFFERENT format than the client (anthropic→cc → a CC accumulator),
   * so a leg-blind factory would produce a malformed outboundResponse. The direct/passthrough legs return
   * their native accumulator regardless of `env` (byte-identical to before the `env` param was restored).
   */
  createResponseAccumulator(env: RequestEnvelope): ResponseAccumulator

  /**
   * observability (S4 per-attempt): derive the history-side effective + wire
   * request descriptors from the prepared wire + env. Optional — the driver
   * records them when present (codecs opt in as they migrate; P2.3-S sampling
   * sink-down). The format-specific message extraction (CC `messages` vs
   * Responses `input`) and the wire `format` label (passthrough vs via-responses)
   * live here, so the driver stays format-agnostic.
   */
  sampleRequest?(wire: PreparedRequest, env: RequestEnvelope): RequestSample
}

/** History-side request descriptors a codec derives per-attempt (envelope-driver.md §4). */
export interface RequestSample {
  /** The post-rewrite logical request (effectiveRequest track). */
  effective: EffectiveRequest
  /** The actual outbound wire bytes (outboundRequest track). */
  wire: WireRequest
}
