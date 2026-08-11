/**
 * v4 pipeline — thin-envelope IR (D2).
 *
 * The single container the driver flows between stages. **Thin**: it unifies only orchestration metadata; the request `body` stays format-native, opaque, and un-normalized so Anthropic direct-connect stays byte-lossless (thinking signatures echoed verbatim — see docs/v4/01-architecture.md §4).
 *
 * The envelope answers **what to send**. What came back is answered by `ctx` and the generation coordinator — response-side accumulators never live here, because an accumulator must keep exactly one mutable identity for the life of one candidate's upstream leg while an envelope is forked per candidate.
 *
 * **Mutability contract (ruled 2026-08-11).** The scopes are MUTABLE and the envelope carries no update methods: a hook, rewrite or stage writes `env.attempt.body = x` directly. The three scope SLOTS are `readonly` so the objects themselves can never be swapped — that is what lets a hook hold `env.request` once and keep reading current values, and it is the whole reason the scopes exist as objects rather than flat fields.
 *
 * The core does not defend itself against hooks. A hook that writes the wrong thing produces a wrong request and an exception where the wrong value is used; it is not validated, sandboxed or rolled back.
 *
 * A NEW envelope is born in exactly two places: `makeEnvelope` at S1, and `createCandidateStateFactory(...).fork()` when a generation candidate branches (`./generation/candidate-state`). Everything between those two points mutates in place.
 */

import type { BetaProbe } from "~/lib/anthropic/pipeline"
import type { RequestContext } from "~/lib/context/request"
import type { PreprocessInfo } from "~/lib/history/types"
import type { Model } from "~/lib/models/client"
import type { RouteOverride } from "~/lib/models/normalize-id"
import type { PrepareHints } from "~/lib/request/retry-types"
import type { ToolNameMapper } from "~/lib/tool-name-mapper"

import type { TranslationConfigSnapshot } from "./semantic/config-snapshot"

/** Client-facing inbound format (route prefix determines it). */
export type ClientFormat = "anthropic" | "openai-cc" | "openai-responses" | "gemini"

/** Upstream endpoint, aligned with a model's `supported_endpoints`. */
export type UpstreamEndpoint = "/v1/messages" | "/chat/completions" | "/responses" | "ws:/responses"

/**
 * A model after `resolveModelName` + `state.modelIndex.get` — the canonical
 * model plus its capabilities. Aliases the single-source `Model` type so the
 * envelope reads intentionally (S1 always resolves before building the
 * envelope, hence non-optional on {@link RequestScope}).
 */
export type ResolvedModel = Model

// ============================================================================
// Lazy message view — read-only projection for rewriters/loggers/route gates
// ============================================================================

/**
 * Thin read-only projection of one message. **Not** a normalization IR — it exposes just enough for routing / logging / gate decisions and never carries round-trip translation. Rewrites that need byte fidelity operate on `env.attempt.body` directly. Fields are added as consumers need them (P1+).
 */
export interface NeutralMessage {
  readonly role: string
  readonly hasThinking: boolean
  readonly hasImages: boolean
  readonly toolUseCount: number
  readonly toolResultCount: number
}

/** Thin read-only projection of one tool definition. */
export interface NeutralTool {
  readonly name: string
}

/** Thin read-only projection of the system prompt. */
export interface NeutralSystem {
  readonly text: string
}

/**
 * Lazy, read-only projection of the current `attempt.body` for rewriters. **Not mandatory** — rewrites needing verbatim fidelity operate on the body directly. Recomputed on every read, so it always reflects the body as last written.
 */
export interface LazyMessageView {
  /** Lazily parse the current body's messages into a neutral read-only shape. */
  readonly messages: ReadonlyArray<NeutralMessage>
  readonly tools: ReadonlyArray<NeutralTool>
  readonly system: NeutralSystem | undefined
  /** Summary metadata (log/route use) — does not trigger full parsing. */
  readonly summary: { messageCount: number; hasTools: boolean; hasThinking: boolean; hasImages: boolean }
}

// ============================================================================
// The three lifetime scopes
// ============================================================================

/**
 * What is settled for the WHOLE client request — one object, shared by reference across every candidate and every attempt.
 *
 * Seeded by the InboundCodec's `parse` at S1, and refined once at S1b where a value cannot be known earlier (gemini's `truncateBaseline` needs the Gemini→CC translation to have run). Because all candidates share this object, a write here is visible to every sibling — that is intended for request-level truth, and it is exactly why mutable holders belong in {@link CandidateScope} instead.
 */
export interface RequestScope {
  clientFormat: ClientFormat
  model: ResolvedModel
  stream: boolean
  /**
   * The explicit outbound-leg pin (`@cc` / `@responses` / `@messages`) parsed off the client's model name by `resolveModelTarget` at S1 (RFC §4.3 / §5). `undefined` = the client typed no suffix, so the router uses the per-inbound default/priority leg. The router (S2) reads it to select `attempt.targetEndpoint`; S1 only carries it here.
   */
  routeOverride?: RouteOverride
  /**
   * The `model_translation` generation this request is decided against, captured once by the ingress middleware before any route or candidate fork (RFC 2026-08-08 §6; see `./semantic/config-snapshot`).
   *
   * It is carried by object identity now, so a retry or fallback leg cannot silently lose it the way it could when four codecs each re-listed the envelope's fields by hand. Nothing prevents a hook from replacing it — the core trusts hooks, and a leg deliberately translated under different rules is that hook's decision to make.
   *
   * `undefined` for envelopes built outside the HTTP ingress (the dry-run debug route, tests).
   */
  translationConfigSnapshot?: TranslationConfigSnapshot
  /**
   * The pre-sanitize payload snapshot the auto-truncate baseline is measured against (stable across retries — a retry rewrites `attempt.body`, so the baseline must be captured before the first dispatch). Format-native (Anthropic `MessagesPayload` / CC `ChatCompletionsPayload`), kept opaque here.
   */
  truncateBaseline?: unknown
  /** The client's inbound `anthropic-beta` header value (seeds the betaProbe candidate ranking). */
  clientAnthropicBeta?: string
  /** The client's raw inbound headers (lowercased) for optional upstream passthrough (Anthropic wire prep reads it). */
  clientRequestHeaders?: Record<string, string>
  /**
   * The initial (attempt-0) sanitization diagnostic the reverse/direct Anthropic leg produced at parse, read back by the handler's pipelineInfo rebuild. Opaque here (Anthropic-shaped).
   */
  initialSanitizationInfo?: unknown
  /** Route-supplied message-level preprocess info (the Anthropic sanitize rewrite + pipelineInfo rebuild read it). */
  preprocessInfo?: PreprocessInfo
  /**
   * Client-original ↔ source-format mapper captured once at parse. Stable across retries; target-wire mappers compose from this provenance rather than the `ctx.toolNameMapper` that response restoration updates per attempt.
   */
  sourceToolNameMapper?: ToolNameMapper | null
  /**
   * True once an InboundCodec's `parse` has populated this envelope's outbound-leg supply.
   *
   * The driver's hybrid cell dispatch (RFC 2026-07-13 §11.6) REQUIRES that supply, so an envelope without it — a driver orchestration unit test with a mock codec, or a format whose parse populates none — stays on the legacy `deps.*` path, where the codec's own direct branch is still byte-equivalent.
   *
   * This used to be inferred from `requestState !== undefined`, i.e. the presence of a data bag was read as a capability. That conflated "a real parse ran" with "that parse happened to have something to put in the bag", and it stopped being expressible at all once the scopes became always-present objects. The capability now says what it means.
   */
  legSupplyReady?: boolean
}

/**
 * The supply owned by ONE generation candidate (`primary` / `hedge` / `recovery` / `continuation`), never shared with a sibling.
 *
 * Every field here is an opaque MUTABLE holder, which is precisely why it cannot live in {@link RequestScope}: a hedge sharing its parent's `betaProbe` would record its own outbound betas into the sibling's probe and corrupt that sibling's retry ranking. `createCandidateStateFactory` refuses to fork a candidate whose source carries one of these without a candidate-local factory — this scope makes that requirement visible in the type rather than only at that throw.
 */
export interface CandidateScope {
  /**
   * The mutable beta probe: `prepareWire` records outbound betas into it per-attempt, and the `unsupported-beta` strategy reads its candidates LAZILY at retry-handle time (RFC §11.2 R3 — reference sharing + lazy read, NEVER a construct-time snapshot). Shared across the ATTEMPTS of one candidate; never across candidates.
   */
  betaProbe?: BetaProbe
  /**
   * The reverse-leg resanitize closure (re-runs the Anthropic sanitize chain on a re-derived payload). A reverse `@messages` leg supplies it from the hub translator; the direct Anthropic leg from its codec.
   */
  resanitize?: (payload: unknown) => unknown
  /**
   * REVERSE `@messages` leg only: the shared `ReverseAnthropicMapperHolder` (kept opaque here — a pipeline module can't import the openai-cc reverse-rewrite type without coupling). The leg's `requestRewrites` (reverse sanitize) and `buildLegStrategies` (reverse resanitize) both read it, so it must be the SAME instance within one candidate. A source codec's parse creates it (`createReverseAnthropicMapperHolder`).
   */
  reverseMapperHolder?: unknown
  /**
   * openai-responses FALLBACK (`/chat`) leg only: the fallback-exchange SCRATCH (RFC §11.2c — responseId/itemId/resolvedModel/rebuiltMessages). Kept opaque here (openai-responses-shaped, and a pipeline module can't import the codec's type). Both the CHAT leg (writes it in `translateOut`, reads `rebuiltMessages` in `prepareWire`) and the openai-responses InboundCodec's render side (reads ids/resolvedModel) reference it. Built LAZILY on the fallback route (never for a direct `/responses` request).
   */
  responsesFallbackScratch?: unknown
}

/**
 * The input to the NEXT upstream dispatch — what a retry, fallback or continuation rewrites.
 *
 * The membership rule is "what the next dispatch consumes", not "what has changed": `body` is rewritten both once by S2 `translateOut` and again by every retry, and it belongs here on the first reading, not the second.
 */
export interface AttemptScope {
  /** Current-format payload; replaced by S2 translateOut with the target-format payload, and again by each retry. */
  body: unknown
  /** Written by S2 (decideRoute); S4 selects the upstream client by it. A fallback leg rewrites it. */
  targetEndpoint: UpstreamEndpoint
  /**
   * Retry intent, REPLACE semantics: attempt 0 clears it and each retry's `RetryAction` fully overwrites it. This is why the request-stable supply lives in {@link RequestScope} instead — routing it through here would let the FIRST hint-bearing retry (e.g. `unsupported-beta` returning `{ excludeBetas }`) wipe the truncation baseline.
   */
  prepareHints: PrepareHints
}

// ============================================================================
// RequestEnvelope
// ============================================================================

/**
 * The driver's per-request container, flowed between the seven stages.
 *
 * The three scopes exist so a field's LIFETIME is a fact about its type rather than a claim in a doc comment. Before they existed, an update carried a hand-written key list that four codecs each re-implemented field by field, and a forgotten field vanished silently with no compile error.
 *
 * See the module docblock for the mutability contract.
 */
export interface RequestEnvelope {
  /** Settled for the whole client request; shared by every candidate. */
  readonly request: RequestScope
  /** Owned by this generation candidate alone. */
  readonly candidate: CandidateScope
  /** Consumed by the next upstream dispatch. */
  readonly attempt: AttemptScope

  /** Lazy read-only projection of `attempt.body`, recomputed per read. */
  readonly view: LazyMessageView

  /** The driver publishes events through it. Belongs to no scope: it outlives every attempt and every candidate. */
  readonly ctx: RequestContext

  /** The codec's format-native lazy-view factory, carried so {@link forkEnvelope} can build a sibling of the same format without knowing which codec produced this one. */
  readonly createView: (body: unknown) => LazyMessageView
}

// ============================================================================
// Construction
// ============================================================================

export interface EnvelopeInit {
  readonly request: RequestScope
  readonly candidate?: CandidateScope
  readonly attempt: AttemptScope
  readonly ctx: RequestContext
  /** The codec's format-native lazy view factory — the ONLY thing that differed between the four hand-copied envelope builders this function replaced. */
  readonly createView: (body: unknown) => LazyMessageView
}

/**
 * Build an envelope. Shared by all four codecs: a field added to any scope needs no per-codec change, because nothing re-lists the scopes' contents.
 */
export function makeEnvelope(init: EnvelopeInit): RequestEnvelope {
  const env: RequestEnvelope = {
    request: init.request,
    candidate: init.candidate ?? {},
    attempt: init.attempt,
    ctx: init.ctx,
    createView: init.createView,
    get view(): LazyMessageView {
      return init.createView(env.attempt.body)
    },
  }
  return env
}

/**
 * Build a SIBLING envelope for a new generation candidate.
 *
 * This is the one place besides {@link makeEnvelope} where an envelope is born, and it exists because the scopes are mutable: two candidates racing on one object would write each other's `attempt.body`. The `request` scope is shared by reference — it is request-level truth, identical for every candidate by definition — while `candidate` and `attempt` are the caller's, built from `createCandidateStateFactory`'s per-candidate factories (`./generation/candidate-state`).
 */
export function forkEnvelope(env: RequestEnvelope, next: { candidate: CandidateScope; attempt: AttemptScope }): RequestEnvelope {
  return makeEnvelope({ request: env.request, candidate: next.candidate, attempt: next.attempt, ctx: env.ctx, createView: env.createView })
}

/**
 * Write the attempt scope and hand the SAME envelope back.
 *
 * Pure ergonomics for the call sites that need an expression rather than a statement — a rewrite returning `{ env, changed }`, a ternary, an object literal. `env.attempt.body = x` is the plain way to say this and is preferred wherever a statement fits. Returning the same object (not a copy) is the point: nothing downstream may assume it received a private envelope.
 */
export function writeAttempt(env: RequestEnvelope, next: Partial<AttemptScope>): RequestEnvelope {
  Object.assign(env.attempt, next)
  return env
}
