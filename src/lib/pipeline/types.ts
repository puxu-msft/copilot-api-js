/**
 * v4 pipeline — stage / driver / retry / transport contracts.
 *
 * The machinery layer around the thin {@link RequestEnvelope}: stage signatures,
 * the driver orchestration contract, the error-driven retry strategy interface
 * (env-based — see docs/v4/03-spec/retry-transport.md §2), and the pure transport
 * send contract.
 *
 * P0.1 defines the interfaces only — **no consumers yet**. The driver (P2) and
 * transport (P0.2/P2) consume them later.
 *
 * Note on naming: the env-based {@link RetryStrategy} here intentionally shares
 * the name with the legacy generic `RetryStrategy<TPayload>` in
 * `~/lib/request/pipeline`. They live in different modules and never collide;
 * the legacy one is replaced by this one as formats migrate (P2 / P0.4).
 */

import type {
  //
  EffectiveRequest,
  WireRequest,
} from "~/lib/context/types"
import type { ApiError } from "~/lib/error"
import type {
  //
  BaseStreamAccumulator,
  SseFrame,
  StreamErrorKind,
} from "~/lib/stream"

import type {
  //
  ClientFormat,
  RequestEnvelope,
  ResolvedModel,
  UpstreamEndpoint,
} from "./envelope"

// ============================================================================
// SSE frames + upstream stream
// ============================================================================

/**
 * One SSE frame flowing from upstream, pre-rewrite. Today this is the raw wire
 * shape (`{ event?, data? }`); it gains a parsed-view discriminant when the
 * response rewrite/translate stages (S5/S6) land (P1/P2).
 */
export type UpstreamFrame = SseFrame

/** One SSE frame flowing to the client, post-rewrite/translate (S5→S7). */
export type ClientFrame = SseFrame

/**
 * The result of a single upstream exchange (S4 output). Streaming responses
 * expose `frames`; non-streaming responses expose `nonStream`. `headers`
 * carries the upstream HTTP response headers for capture (Retry-After, quota).
 */
export interface UpstreamStream {
  frames: AsyncIterable<UpstreamFrame>
  /** Parsed JSON body for non-streaming responses (undefined when streaming). */
  nonStream?: unknown
  headers: Headers
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
 * Pure send/receive, format-agnostic. Extracted from the three clients' shared
 * skeleton (docs/v4/02-current-state.md §6.1): token check → combine signals →
 * fetch(DISABLE_BUILTIN_FETCH_TIMEOUT) → captureHttpHeaders → throw HTTPError on
 * !ok → stream ? SSE iterable : json. The adaptive rate-limiter wraps this at
 * the call site (kept, see retry-transport.md §5).
 */
export interface Transport {
  send(wire: PreparedRequest, env: RequestEnvelope): Promise<UpstreamStream>
}

// ============================================================================
// Error-driven retry strategy (env-based)
// ============================================================================

/**
 * An error-driven retry strategy. Unlike the legacy `RetryStrategy<TPayload>`,
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
   * adapter forwards it into the legacy `ResolvedContext.meta`, where
   * `unsupported-beta-retry.onResolved` reads `meta.probedBetas` to fixate the
   * located betas into the negotiation cache.
   */
  onResolved?(env: RequestEnvelope, meta?: Record<string, unknown>): void | Promise<void>
}

/**
 * The outcome of a strategy's `handle`. `retry` carries the modified envelope
 * for the next attempt; `learning` retries draw from a separate budget (see
 * retry-transport.md §2 / pipeline.ts `MAX_LEARNING_RETRIES`).
 *
 * `meta` is opaque per-retry diagnostic data (the legacy `RetryAction.meta` — e.g.
 * `truncateResult` / `sanitization` / `probedBetas` / `strippedBetas`). The driver
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
 * S2 routing outcome (codec.decideRoute). Unifies the 4 scattered passthrough
 * checks + Gemini's no-gate translate (docs/v4/03-spec/codec.md §2).
 *
 * The `translate` variant omits a `from` field: the source format is always
 * available as `env.clientFormat`, so carrying it here would duplicate state.
 * (docs/v4/01-architecture.md §6 shows a `from`-bearing variant; codec.md — the
 * authoritative decideRoute spec — omits it, and that is the version used here.)
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
  /** Model override injected by Azure deployment routing (codec.parse reads it). */
  readonly modelOverride?: string
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
  readonly preResolved?: { name: string; model: ResolvedModel | undefined }
  /** Downstream client-disconnect signal, folded into the upstream fetch signal. */
  readonly clientAbortSignal?: AbortSignal
}

/**
 * Orchestrates the stage sequence, publishing events + sampling raw data at
 * each stage boundary. Lifted+merged from the current `executeRequestPipeline`
 * retry loop and the handlers' orchestration skeleton (docs/v4/01-architecture.md §1.3).
 */
export interface PipelineDriver {
  /** Request side: run S1→S4 (S4 contains error-driven retry). */
  runRequest(raw: RawHttpRequest): Promise<DriverRequestResult>
  /** Response side: build the S5→S6→S7 streaming transform chain. */
  runResponse(upstream: UpstreamStream, env: RequestEnvelope): AsyncIterable<ClientFrame>
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

/**
 * One format's codec — encapsulates all "this format vs inbound/upstream"
 * differences (docs/v4/03-spec/codec.md §1). The driver consumes it at the
 * stage boundaries; each format implements one (P2.2–P2.6). The driver treats it
 * as an opaque dependency, so P2.1's skeleton + tests use a mock codec.
 */
export interface FormatCodec {
  readonly format: ClientFormat

  /** S1: parse inbound HTTP → envelope (model resolution, body extraction, ctx). */
  parse(raw: RawHttpRequest): RequestEnvelope

  /** S2: passthrough / translate / reject decision (unifies the 4 scattered checks). */
  decideRoute(env: RequestEnvelope): RouteDecision

  /** S2: translate body to the target-endpoint format (passthrough = identity). */
  translateOut(env: RequestEnvelope): RequestEnvelope

  /**
   * S4 last-mile: derive the wire (header + body trim) for one attempt from env
   * (consumes prepareHints + negotiation cache + model + config). Idempotent for
   * a given env; does NOT write back to env.body (retry-transport.md §3).
   */
  prepareWire(env: RequestEnvelope): PreparedRequest

  /** S6: translate one upstream frame back to the client protocol (passthrough = identity). */
  renderResponse(frame: UpstreamFrame, env: RequestEnvelope): ClientFrame | Array<ClientFrame>

  /** S6 non-streaming: translate the whole upstream response back to the client. */
  renderResponseNonStreaming(upstream: unknown, env: RequestEnvelope): unknown

  /** S7: shape a mid-stream lifecycle error into this protocol's error frame. */
  formatError(err: ClassifiedStreamError, env: RequestEnvelope): ClientFrame

  /** observability: the format's response accumulator factory (HistorySink rebuild). */
  createResponseAccumulator(): ResponseAccumulator

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
