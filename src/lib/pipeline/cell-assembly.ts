/**
 * CellAssembly — the centralized (clientFormat × targetEndpoint) 2D outbound-concern assembler.
 *
 * RFC 2026-07-13 §11 (definitive v2 design). Replaces the scattered outbound-concern supply
 * (`{strategy-registry supply bag + 4 handler supply factories + codec cross-format delegate + codec
 * internal isForwardTranslateLeg fork}`) with a SINGLE assembly resolver keyed by the cell's two axes.
 *
 * ## The two axes (why a 2D assembler, RFC §0.1 BLOCK-1)
 * The outbound strategy STACK's SHAPE is a function of BOTH axes, not one:
 *   - the WIRE (translateOut / requestRewrites / prepareWire / responseRewrites / sampleWireTrack) is keyed
 *     by `targetEndpoint` — the {@link OutboundLeg} (Anthropic `/v1/messages` / CC `/chat/completions` /
 *     Responses `/responses`+ws).
 *   - the retry SEMANTICS (auto-truncate? maxRetries?) is keyed by `clientFormat` — {@link RETRY_SEMANTICS}
 *     — but its semantic HALF reads `env.targetEndpoint` too (R1/HIGH-A: `(openai-responses, /v1/messages)`
 *     reverse leg has auto-truncate ON while its `(openai-responses, /chat|/responses)` direct legs have it
 *     OFF — a 2D function, NOT a clientFormat scalar).
 *
 * `resolveCellAssembly(cf, te)` composes the two: the leg supplies the wire methods + a wire strategy
 * builder; the retry semantics supplies auto-truncate/maxRetries; {@link CellAssembly.buildStrategies}
 * combines them. Both records are EXHAUSTIVE over their key type, so a missing cell is a COMPILE error —
 * precisely eliminating the Phase-7 "switch missing case → default throw → silent 500" class (RFC §11.1).
 * Honest boundary: the exhaustiveness covers cell EXISTENCE; that `env.body` is the cell's canonical shape
 * stays unchecked (`env.body:unknown`), guarded by the assembly's translateOut↔buildStrategies↔prepareWire
 * three-party convention + the L1 "every cell's buildStrategies is non-empty + does not throw" test.
 *
 * ## Cross-axis state carriers (RFC §11.2 / §11.9 HIGH-B)
 * A CellAssembly is STATELESS per cell (one instance per `cf × te`) — every method reads what it needs
 * from `env`. Request-lifecycle-STABLE supply (truncateBaseline / resanitize / the shared mutable betaProbe
 * / anthropic-beta seed) lives on `env.requestState` (a `readonly` field the `with()` copy preserves by
 * reference — NOT the replace-semantics `prepareHints`, R2). Per-attempt retry intent stays in
 * `prepareHints`. Side-channel recordings (effectiveMessages / initialSanitizationInfo / strippedCacheControl)
 * are written to `ctx`. The betaProbe is read LAZILY from `env.requestState.betaProbe` at each call (R3 —
 * reference sharing + lazy read, never a construct-time snapshot).
 *
 * ## Migration state (C1-C5)
 * C1 (this commit) lands the CONTRACTS only — the two records throw placeholders; {@link MIGRATED_LEGS} is
 * empty so the driver's hybrid dispatch (added in C2 with the first real assembly) always takes the legacy
 * path → byte-identical. C2 fills `/v1/messages`, C3 `/chat/completions`, C4 `/responses`+ws; C5 asserts
 * `MIGRATED_LEGS` covers every leg and retires the strategy-registry supply bag.
 */

import {
  //
  anthropicMessagesLeg,
  anthropicMessagesRetrySemantics,
  anthropicReverseRetrySemantics,
} from "~/lib/codec/anthropic/anthropic-cell"
import {
  //
  chatCompletionsLeg,
  chatCompletionsRetrySemantics,
  responsesFallbackRetrySemantics,
} from "~/lib/codec/openai-cc/openai-cc-cell"
import {
  //
  responsesDirectRetrySemantics,
  responsesLeg,
  viaResponsesRetrySemantics,
  wsResponsesLeg,
} from "~/lib/codec/openai-responses/openai-responses-cell"
import { ENDPOINT } from "~/lib/models/endpoint"

import type {
  //
  ClientFormat,
  RequestEnvelope,
  UpstreamEndpoint,
} from "./envelope"
import type {
  //
  RequestRewrite,
  ResponseRewrite,
} from "./rewrite-registry"
import type {
  //
  PreparedRequest,
  RequestSample,
  RetryStrategy,
} from "./types"

// ============================================================================
// Retry semantics (clientFormat-keyed, reads env.targetEndpoint — the maxRetries corner)
// ============================================================================

/**
 * The retry-strategy SEMANTIC spec the wire leg does NOT own: the reactive-retry budget.
 * Produced by {@link RETRY_SEMANTICS}[clientFormat](env) — the `env` argument is load-bearing: `maxRetries`
 * is a 2D function that reads `env.targetEndpoint`, NOT a clientFormat scalar (the openai-responses DIRECT
 * `/responses` + FALLBACK `/chat` cells cap at 1, while the SAME client's REVERSE `@messages` cell — and
 * every other cell — uses `state.maxReactiveRetries`).
 *
 * (Historically this also carried an `autoTruncate` flag — the R1/HIGH-A corner — AND a diagnostic `label`
 * string (dropped Task 6 / plan carryover: confirmed dead end-to-end, its only consumer — the CC console-log
 * line — was removed 2026-07-13 alongside auto-truncate). Master removed auto-truncate entirely 2026-07-13,
 * so every cell's strategy STACK is now identical [network → server-error → token-refresh]; the only
 * residual per-cell difference is `maxRetries` + which builder's body shape the baseline is [CC vs
 * Responses], dispatched by clientFormat in `buildCcFamilyLegStrategies`.)
 */
export interface RetrySemanticsSpec {
  /** Reactive-retry cap for THIS cell (the Responses DIRECT/fallback cells 1; every other cell `maxReactiveRetries`). */
  readonly maxRetries: number
}

/**
 * The retry SEMANTIC half, keyed by `clientFormat`, evaluated per-request against `env` (so a cell's
 * `env.targetEndpoint` selects the maxRetries corner). EXHAUSTIVE over {@link ClientFormat} → a new client
 * format is a compile error until its semantics land. C5: every cell is migrated, so every branch resolves
 * (the per-cf functions are total over {@link UpstreamEndpoint} — a new leg trips `assertExhaustiveEndpoint`).
 */
export const RETRY_SEMANTICS: Record<ClientFormat, (env: RequestEnvelope) => RetrySemanticsSpec> = {
  // anthropic: /v1/messages DIRECT (C2a) + `@cc`/`@responses` FORWARD (C3/C4 — the CC stack against the
  // hub-translated CC body; the `@responses` leg's CC→Responses wire step is deferred to prepareWire).
  anthropic: (env) => {
    switch (env.targetEndpoint) {
      case ENDPOINT.MESSAGES: {
        return anthropicMessagesRetrySemantics()
      }
      case ENDPOINT.CHAT_COMPLETIONS: {
        return chatCompletionsRetrySemantics()
      }
      case ENDPOINT.RESPONSES:
      case ENDPOINT.WS_RESPONSES: {
        return viaResponsesRetrySemantics()
      }
      default: {
        return assertExhaustiveEndpoint(env.targetEndpoint)
      }
    }
  },
  // openai-cc: DIRECT `/chat` (C3) + via-responses `/responses` (C4 — the CC stack against the CC body,
  // translation deferred to prepareWire) + REVERSE `@messages` (C2b — the Anthropic stack).
  "openai-cc": (env) => {
    switch (env.targetEndpoint) {
      case ENDPOINT.MESSAGES: {
        return anthropicReverseRetrySemantics()
      }
      case ENDPOINT.CHAT_COMPLETIONS: {
        return chatCompletionsRetrySemantics()
      }
      case ENDPOINT.RESPONSES:
      case ENDPOINT.WS_RESPONSES: {
        return viaResponsesRetrySemantics()
      }
      default: {
        return assertExhaustiveEndpoint(env.targetEndpoint)
      }
    }
  },
  // openai-responses: the R1/HIGH-A corner — DIRECT `/responses` + FALLBACK `/chat` are auto-truncate OFF
  // (the Responses stack, maxRetries 1), while its REVERSE `@messages` cell (C2b) is auto-truncate ON (the
  // Anthropic stack). RETRY_SEMANTICS reads env.targetEndpoint to pick → a 2D function, NOT a cf scalar.
  "openai-responses": (env) => {
    switch (env.targetEndpoint) {
      case ENDPOINT.MESSAGES: {
        return anthropicReverseRetrySemantics()
      }
      case ENDPOINT.CHAT_COMPLETIONS: {
        return responsesFallbackRetrySemantics()
      }
      case ENDPOINT.RESPONSES:
      case ENDPOINT.WS_RESPONSES: {
        return responsesDirectRetrySemantics()
      }
      default: {
        return assertExhaustiveEndpoint(env.targetEndpoint)
      }
    }
  },
  // gemini: FORWARD `@cc` (C3) + via-responses `/responses` (C4) + REVERSE `@messages` (C2b).
  gemini: (env) => {
    switch (env.targetEndpoint) {
      case ENDPOINT.MESSAGES: {
        return anthropicReverseRetrySemantics()
      }
      case ENDPOINT.CHAT_COMPLETIONS: {
        return chatCompletionsRetrySemantics()
      }
      case ENDPOINT.RESPONSES:
      case ENDPOINT.WS_RESPONSES: {
        return viaResponsesRetrySemantics()
      }
      default: {
        return assertExhaustiveEndpoint(env.targetEndpoint)
      }
    }
  },
}

/** Compile-time exhaustiveness guard: `targetEndpoint` narrows to `never` once all 4 legs are handled. */
function assertExhaustiveEndpoint(te: never): never {
  throw new Error(`[cell-assembly] RETRY_SEMANTICS: unhandled targetEndpoint ${String(te)} (a new UpstreamEndpoint must add its semantics)`)
}

// ============================================================================
// Outbound leg (targetEndpoint-keyed wire concerns)
// ============================================================================

/**
 * The WIRE half of a cell, keyed by `targetEndpoint` — the outbound-leg concerns that were scattered across
 * the codec's per-leg `prepareWire`/`renderResponse` forks + the cross-format delegate. Every method reads
 * `env` (incl. `env.requestState` for the stable supply, `env.clientFormat` where translateOut selects the
 * source translator). Produces the wire strategy builder {@link CellAssembly.buildStrategies} composes with
 * the {@link RetrySemanticsSpec}.
 */
export interface OutboundLeg {
  readonly targetEndpoint: UpstreamEndpoint
  /** S2: translate `env.body` from `env.clientFormat` to this leg's upstream format (identity for a direct leg). */
  translateOut(env: RequestEnvelope): RequestEnvelope
  /** This leg's S3 upstream-wire request-rewrite chain (e.g. reverse Anthropic sanitize on a `@messages` leg). */
  requestRewrites(env: RequestEnvelope): ReadonlyArray<RequestRewrite>
  /** S4 last-mile: derive the wire bytes for one attempt; writes `env.requestState.betaProbe.recordOutbound` + ctx side-channel. */
  prepareWire(env: RequestEnvelope): PreparedRequest
  /** This leg's S5 response-rewrite chain. */
  responseRewrites(env: RequestEnvelope): ReadonlyArray<ResponseRewrite>
  /** S4 first-attempt async pre-send hook (Anthropic pre-flight truncation); omitted = no-op. */
  readonly preSend?: (env: RequestEnvelope) => Promise<RequestEnvelope>
  /** observability: the upstream-wire request descriptors (outboundRequest track); writes ctx effectiveMessages side-channel. */
  sampleWireTrack(wire: PreparedRequest, env: RequestEnvelope): RequestSample
  /**
   * The wire-side retry strategies for THIS leg, given the composed {@link RetrySemanticsSpec} (auto-truncate /
   * maxRetries) + `env` (reads `env.requestState` for the stable supply — truncateBaseline / resanitize /
   * betaProbe). The Phase-7 direct guard: this MUST be non-empty for every live cell (L1 test).
   */
  buildLegStrategies(spec: RetrySemanticsSpec, env: RequestEnvelope): ReadonlyArray<RetryStrategy>
}

/**
 * The WIRE half, keyed by `targetEndpoint`. EXHAUSTIVE over {@link UpstreamEndpoint} → a new leg is a
 * compile error until it lands. C1: every entry throws (no leg migrated yet).
 */
export const OUTBOUND_LEGS: Record<UpstreamEndpoint, OutboundLeg> = {
  [ENDPOINT.MESSAGES]: anthropicMessagesLeg,
  [ENDPOINT.CHAT_COMPLETIONS]: chatCompletionsLeg,
  [ENDPOINT.RESPONSES]: responsesLeg,
  [ENDPOINT.WS_RESPONSES]: wsResponsesLeg,
}

// ============================================================================
// CellAssembly — the composed (cf × te) view the driver consumes
// ============================================================================

/**
 * The composed per-cell assembly the driver consumes — the leg's wire methods plus a `buildStrategies` that
 * combines the leg's wire strategies with the clientFormat's {@link RetrySemanticsSpec}. Stateless (one per
 * `cf × te`); every method reads `env`. Produced by {@link resolveCellAssembly}.
 */
export interface CellAssembly {
  readonly clientFormat: ClientFormat
  readonly targetEndpoint: UpstreamEndpoint
  translateOut(env: RequestEnvelope): RequestEnvelope
  requestRewrites(env: RequestEnvelope): ReadonlyArray<RequestRewrite>
  prepareWire(env: RequestEnvelope): PreparedRequest
  responseRewrites(env: RequestEnvelope): ReadonlyArray<ResponseRewrite>
  readonly preSend?: (env: RequestEnvelope) => Promise<RequestEnvelope>
  sampleWireTrack(wire: PreparedRequest, env: RequestEnvelope): RequestSample
  /** The full retry stack for THIS cell: `buildLegStrategies(RETRY_SEMANTICS[cf](env), env)`. */
  buildStrategies(env: RequestEnvelope): ReadonlyArray<RetryStrategy>
}

/**
 * Resolve the CellAssembly for `(clientFormat × targetEndpoint)` by composing the two exhaustive records:
 * the {@link OutboundLeg} (wire) + {@link RETRY_SEMANTICS} (semantics). Both lookups are total (exhaustive
 * records) — a missing cell cannot compile. `buildStrategies` evaluates the semantics against `env` (R1
 * corner) then hands it to the leg's wire strategy builder.
 */
export function resolveCellAssembly(clientFormat: ClientFormat, targetEndpoint: UpstreamEndpoint): CellAssembly {
  const leg = OUTBOUND_LEGS[targetEndpoint]
  const semantics = RETRY_SEMANTICS[clientFormat]
  const preSend = leg.preSend
  return {
    clientFormat,
    targetEndpoint,
    translateOut: (env) => leg.translateOut(env),
    requestRewrites: (env) => leg.requestRewrites(env),
    prepareWire: (env) => leg.prepareWire(env),
    responseRewrites: (env) => leg.responseRewrites(env),
    ...(preSend && { preSend: (env: RequestEnvelope) => preSend(env) }),
    sampleWireTrack: (wire, env) => leg.sampleWireTrack(wire, env),
    buildStrategies: (env) => leg.buildLegStrategies(semantics(env), env),
  }
}

// ============================================================================
// Hybrid dispatch shim (RFC §11.6 / §11.9 MEDIUM — named, asserted empty at C5)
// ============================================================================

/**
 * The set of (clientFormat × targetEndpoint) CELLS the driver dispatches through {@link resolveCellAssembly}
 * instead of the legacy `deps.*` single slots. CELL-keyed (`${clientFormat}|${targetEndpoint}`) so a partially
 * migrated leg (the `/v1/messages` leg is shared by anthropic-direct + 3 reverse cells) has NO double-active:
 * only the migrated cell forks. GROWS one cell group per commit — C2a adds `anthropic|/v1/messages`, C2b the
 * 3 reverse `@messages` cells, C3 the `/chat/completions` cells, C4 the `/responses`+ws cells. C5 asserts it
 * equals the full cell space (the shim collapses). An unmigrated cell takes the legacy path → byte-identical
 * (an explicitly-harmless transition, `large-refactor` §3).
 */
export const MIGRATED_CELLS: ReadonlySet<string> = new Set<string>([
  cellKey("anthropic", ENDPOINT.MESSAGES),
  cellKey("openai-cc", ENDPOINT.MESSAGES),
  cellKey("openai-responses", ENDPOINT.MESSAGES),
  cellKey("gemini", ENDPOINT.MESSAGES),
  // C3: the 3 CC-shaped `/chat/completions` cells (openai-cc DIRECT + anthropic/gemini FORWARD `@cc`).
  cellKey("openai-cc", ENDPOINT.CHAT_COMPLETIONS),
  cellKey("anthropic", ENDPOINT.CHAT_COMPLETIONS),
  cellKey("gemini", ENDPOINT.CHAT_COMPLETIONS),
  // C4: the `/responses` leg (openai-responses DIRECT + openai-cc/gemini via-responses + anthropic FORWARD
  // `@responses`) + the openai-responses `(/chat)` FALLBACK. This completes the 12 reachable cells (the
  // `ws:/responses` transport is never a routed targetEndpoint — the router only returns `/responses`).
  cellKey("openai-responses", ENDPOINT.RESPONSES),
  cellKey("openai-cc", ENDPOINT.RESPONSES),
  cellKey("gemini", ENDPOINT.RESPONSES),
  cellKey("anthropic", ENDPOINT.RESPONSES),
  cellKey("openai-responses", ENDPOINT.CHAT_COMPLETIONS),
])

/** The `MIGRATED_CELLS` key for a cell. */
export function cellKey(clientFormat: ClientFormat, targetEndpoint: UpstreamEndpoint): string {
  return `${clientFormat}|${targetEndpoint}`
}

/** Is this CELL dispatched through the CellAssembly (vs the legacy `deps.*` slots)? Reads {@link MIGRATED_CELLS}. */
export function isCellMigrated(clientFormat: ClientFormat, targetEndpoint: UpstreamEndpoint): boolean {
  return MIGRATED_CELLS.has(cellKey(clientFormat, targetEndpoint))
}
