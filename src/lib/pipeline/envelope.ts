/**
 * v4 pipeline — thin-envelope IR (D2).
 *
 * The single container the driver flows between stages. **Thin**: it unifies
 * only orchestration metadata; the request `body` stays format-native, opaque,
 * and un-normalized so Anthropic direct-connect stays byte-lossless (thinking
 * signatures echoed verbatim — see docs/v4/01-architecture.md §4).
 *
 * P0.1 defines the interfaces only — there are **no consumers yet**. The driver
 * (P2), codecs (P2), and rewrite registry (P1) consume them later.
 */

import type { RequestContext } from "~/lib/context/request"
import type { Model } from "~/lib/models/client"
import type { PrepareHints } from "~/lib/request/pipeline"

/** Client-facing inbound format (route prefix determines it). */
export type ClientFormat = "anthropic" | "openai-cc" | "openai-responses" | "gemini"

/** Upstream endpoint, aligned with a model's `supported_endpoints`. */
export type UpstreamEndpoint = "/v1/messages" | "/chat/completions" | "/responses" | "ws:/responses"

/**
 * A model after `resolveModelName` + `state.modelIndex.get` — the canonical
 * model plus its capabilities. Aliases the single-source `Model` type so the
 * envelope reads intentionally (S1 always resolves before building the
 * envelope, hence non-optional on {@link RequestEnvelope}).
 */
export type ResolvedModel = Model

// ============================================================================
// Lazy message view — read-only projection for rewriters/loggers/route gates
// ============================================================================

/**
 * Thin read-only projection of one message. **Not** a normalization IR — it
 * exposes just enough for routing / logging / gate decisions and never carries
 * round-trip translation. Rewrites that need byte fidelity operate on
 * `env.body` directly. Fields are added as consumers need them (P1+).
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
 * Lazy, read-only projection of the current `body` for rewriters. **Not
 * mandatory** — rewrites needing verbatim fidelity operate on `body` directly.
 * The projection is cached and invalidated when `body` changes.
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
// RequestEnvelope
// ============================================================================

/**
 * The driver's per-request container, flowed between the seven stages.
 *
 * Immutability contract: {@link RequestEnvelope.with} returns a new envelope
 * (shallow copy + patch). The deep structure of `body` is updated immutably by
 * rewriters (spread). `ctx` is the one shared stateful handle — the driver and
 * subscribers use it to publish events and sample raw data.
 */
export interface RequestEnvelope {
  // ── Orchestration metadata ──
  readonly clientFormat: ClientFormat
  /** Written by S2 (decideRoute); S4 selects the client by it. */
  targetEndpoint: UpstreamEndpoint
  readonly model: ResolvedModel
  readonly stream: boolean

  // ── Opaque body (format-native payload, byte-faithful) ──
  /** Current-format payload; replaced by S2 translateOut with the target-format payload. */
  body: unknown

  // ── Lazy parsed view (optional read-only convenience) ──
  readonly view: LazyMessageView

  // ── Retry intent (accumulated inside S4, replace semantics) ──
  prepareHints: PrepareHints

  // ── Cross-cutting handle (lifecycle + recording) ──
  /** Already exists; the driver publishes events through it. */
  readonly ctx: RequestContext

  // ── Immutable update ──
  with(patch: Partial<Pick<RequestEnvelope, "body" | "targetEndpoint" | "prepareHints">>): RequestEnvelope
}
