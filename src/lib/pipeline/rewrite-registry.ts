/**
 * v4 pipeline — rewrite registry (request/response transform chains).
 *
 * Reorganizes the current 40+ rewrite actions (docs/v4/02-current-state.md §2/§3)
 * from "handler-inlined + order maintained by comments" into "named, pluggable,
 * registry-declared-order" transform chains. The driver (P2) assembles a chain
 * by filtering on (format, config, context) and sorting by the declared `order`
 * key — replacing the comment-maintained hard ordering with a checkable contract
 * (docs/v4/03-spec/rewrite-registry.md §3).
 *
 * P1.1 defines the interfaces + assemblers only. The registries are empty here;
 * P1.2–P1.6 populate them (Anthropic tool/sanitize, prepare, OpenAI, response
 * rewrites). Until then there are no consumers — pure addition.
 */

import type { RequestEnvelope } from "./envelope"
import type { UpstreamFrame } from "./types"

// ============================================================================
// Request-side rewrites (S3)
// ============================================================================

/**
 * One named request rewrite. The driver applies these in `order` after
 * assembly. `appliesTo` is the format + config(state) + context gate; `apply`
 * is a pure immutable transform returning the new envelope plus a `changed`
 * flag (drives the `request.rewrite_applied` diagnostic — `changed:false` is not
 * recorded).
 */
export interface RequestRewrite {
  /** Unique name; enters history sanitization diagnostics. */
  readonly name: string
  /** Assembly sort key — encodes the declared-order contract (§3). */
  readonly order: number
  /** Format + config(state) + context gate. */
  appliesTo(env: RequestEnvelope): boolean
  /** Pure transform over the envelope. */
  apply(env: RequestEnvelope): RewriteResult
}

/** The outcome of a {@link RequestRewrite.apply}. */
export interface RewriteResult {
  /** Immutably-updated envelope. */
  env: RequestEnvelope
  /** Whether anything actually changed (`false` → diagnostic not recorded). */
  changed: boolean
  /** Optional counters, e.g. `{ orphansRemoved: 2, remindersStripped: 1 }`. */
  stats?: Record<string, number>
}

// ============================================================================
// Response-side rewrites (S5)
// ============================================================================

/**
 * Per-request, per-rewrite private mutable state (cross-frame index maps,
 * buffers). Each response rewrite owns its concrete state shape; the registry
 * exposes the opaque base, and rewrites narrow internally. Created once per
 * request via {@link ResponseRewrite.createState}.
 */
export interface RewriteState {
  [key: string]: unknown
}

/**
 * The action a {@link ResponseRewrite.transform} returns for one frame:
 * - `emit`   — replace with 0+ frames (verbatim passthrough = `[frame]`)
 * - `suppress` — drop this frame (e.g. server-tool filtering)
 * - `buffer` — hold this frame back; the rewrite accumulates it in its own
 *   `state`. The driver does NOT retain buffered frames — accumulation is the
 *   rewrite's responsibility. A mid-stream flush (e.g. tool-input decoder at a
 *   `content_block_stop` block boundary) is expressed by `transform` returning
 *   `emit` with the accumulated frames at that boundary; `flush` is only the
 *   stream-end drain.
 */
export type FrameAction = { kind: "emit"; frames: Array<UpstreamFrame> } | { kind: "suppress" } | { kind: "buffer" }

/**
 * One named response rewrite. Applied per-frame in `order`; may emit / replace /
 * suppress / buffer (and flush buffered frames at stream end). Operates only on
 * the current upstream-protocol frames (translation back to the client is S6,
 * docs/v4/03-spec/rewrite-registry.md §5).
 *
 * `createState` is added beyond the spec sketch (which shows only the methods):
 * the per-request private state must be instantiated somewhere, and emit-only
 * rewrites (heartbeat, truncation-marker) simply omit it.
 *
 * Driver state contract: the driver passes `createState?.() ?? {}`, so `state`
 * is always a fresh object, never `undefined` — stateless rewrites receive an
 * empty `{}` they may ignore (resolves the "what does a stateless rewrite get?"
 * gap before the first stateless response rewrite lands in P1.5).
 *
 * Open question deferred to P1.5 (recorded in docs/v4/05-progress.md): the
 * timer-driven `heartbeat` (order 999) injects during upstream SILENCE — no
 * frame arrives to drive `transform`. A pure per-frame `transform` cannot
 * express that. P1.5 must decide: keep heartbeat as a handler-side bypass (the
 * §4 table row being a conceptual classification), or extend this interface
 * with an idle/timer hook. `truncation-marker` (first-frame trigger) IS
 * expressible here.
 */
export interface ResponseRewrite {
  readonly name: string
  readonly order: number
  appliesTo(env: RequestEnvelope): boolean
  /**
   * Create this rewrite's private per-request state. Omitted = stateless. Receives
   * the parsed `env` so a rewrite can seed its state from request data (e.g. the
   * tool names / tool-name mapper a buffering rewrite needs).
   */
  createState?(env: RequestEnvelope): RewriteState
  /** Per-frame transform; may emit/replace/suppress/buffer. */
  transform(frame: UpstreamFrame, state: RewriteState): FrameAction
  /** Flush buffered frames at stream end (e.g. tool-input decoder at content_block_stop). */
  flush?(state: RewriteState): Array<UpstreamFrame>
}

// ============================================================================
// Registries + assemblers
// ============================================================================

/**
 * The registered request rewrites. Empty in P1.1; populated by P1.2–P1.4 as the
 * Anthropic / OpenAI rewrites are wrapped. Static composition (not runtime
 * registration) keeps assembly deterministic and avoids a mutable global
 * singleton that would leak across bun's single-process test runs.
 */
export const REQUEST_REWRITES: ReadonlyArray<RequestRewrite> = []

/**
 * Response-rewrite assembly order (ASCENDING = runs first). Phase 4 registers the
 * four Anthropic rewrites at these orders; the values encode hard contracts the
 * handwritten pump used to get from closure nesting (streaming-pump.ts:195-228):
 *
 *   - `recoverToolCall` (100) MUST precede `serverToolFilter` — recover-tool-call/
 *     stream.ts:40 hard-assumes it runs BEFORE the filter: it emits wire-name tool_use
 *     on the UPSTREAM index space (`maxUpstreamIndexSeen + k`); the filter then restores
 *     client names + densifies indices. Reversed → index/name corruption.
 *   - `thinkingSignatureCompat` (150) reshapes thinking frames; independent of the
 *     buffering rewrites but pinned for deterministic assembly.
 *   - `toolInputDecode` (200) runs AFTER recover so a recover-synthesized/flushed
 *     tool_use frame threads through the decoder (recover.flush → decode.transform →
 *     decode.flush; the flushChain cascade — driver.ts `flushChain`).
 *   - `serverToolFilter` (300) runs LAST so its index densify sees the FINAL block set
 *     (after recover added synthesized blocks + decode finalized buffered input).
 *
 * The buffer/flush + multi-buffer cascade + index-densify invariants these orders
 * depend on are locked by tests/pipeline/response-rewrite-contract.unit.test.ts.
 */
export const RESPONSE_REWRITE_ORDER = {
  recoverToolCall: 100,
  thinkingSignatureCompat: 150,
  toolInputDecode: 200,
  serverToolFilter: 300,
} as const

/** The registered response rewrites. Empty in P1.1; populated by Phase 4 (RFC §4.A1). */
export const RESPONSE_REWRITES: ReadonlyArray<ResponseRewrite> = []

/**
 * Assemble the request-rewrite chain for an envelope: keep the registered
 * rewrites whose `appliesTo` passes, then sort by `order` (§2). Returns a fresh
 * array — the registry is never mutated (filter copies; sort acts on the copy).
 * `Array.prototype.sort` is stable, so equal-`order` ties preserve registry
 * order (cross-format ties are mutually exclusive via `appliesTo`).
 *
 * The `registry` param defaults to {@link REQUEST_REWRITES}; tests inject their
 * own fixture registry, the driver (P2) passes the module default.
 */
export function assembleRequestRewrites(env: RequestEnvelope, registry: ReadonlyArray<RequestRewrite> = REQUEST_REWRITES): Array<RequestRewrite> {
  return registry.filter((r) => r.appliesTo(env)).sort((a, b) => a.order - b.order)
}

/**
 * Assemble the response-rewrite chain for an envelope (same filter-by-appliesTo
 * + sort-by-order semantics as {@link assembleRequestRewrites}).
 */
export function assembleResponseRewrites(env: RequestEnvelope, registry: ReadonlyArray<ResponseRewrite> = RESPONSE_REWRITES): Array<ResponseRewrite> {
  return registry.filter((r) => r.appliesTo(env)).sort((a, b) => a.order - b.order)
}
