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

import type { ApiError } from "~/lib/error"
import type { SseFrame } from "~/lib/stream"

import type {
  //
  ClientFormat,
  RequestEnvelope,
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
 * The final bytes sent upstream for one attempt, produced by `prepareWire(env)`
 * (the per-attempt "last-mile" header/body trim). Does NOT write back to
 * `env.body` — `env.body` stays the rewritten logical request (effectiveRequest),
 * `wire` is the outboundRequest (the two history tracks).
 *
 * NOT the same as the history-side `WireRequest` in `~/lib/context/types`: that
 * one is the per-attempt outbound *snapshot* recorded for history
 * (`{ model, messages, payload, headers, format }`), this one is the *actual*
 * bytes transport sends (`{ url, headers, body, stream }`). Distinct concepts,
 * distinct tracks; they only share a name today. Convergence (rename one) is
 * deferred to P2 when transport lands and both may co-exist in one file — see
 * docs/v4/05-progress.md 遗留与决策追踪.
 */
export interface WireRequest {
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
  send(wire: WireRequest, env: RequestEnvelope): Promise<UpstreamStream>
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
  /** Commit learning after a retry produced by THIS strategy ultimately succeeded. */
  onResolved?(env: RequestEnvelope): void | Promise<void>
}

/**
 * The outcome of a strategy's `handle`. `retry` carries the modified envelope
 * for the next attempt; `learning` retries draw from a separate budget (see
 * retry-transport.md §2 / pipeline.ts `MAX_LEARNING_RETRIES`).
 */
export type RetryAction = { kind: "retry"; env: RequestEnvelope; waitMs?: number; learning?: boolean } | { kind: "abort"; error: ApiError }

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
  /** Model override injected by Azure deployment routing (codec.parse reads it). */
  readonly modelOverride?: string
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
 * messages:165 rejecting before context creation).
 */
export type DriverRequestResult =
  | { ok: true; upstream: UpstreamStream; env: RequestEnvelope }
  | { ok: false; rejection: { status: number; body: unknown; format: ClientFormat } }
