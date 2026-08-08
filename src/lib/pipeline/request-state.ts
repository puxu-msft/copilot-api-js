/**
 * `RequestState` — the request-lifecycle-STABLE state carrier (RFC 2026-07-13 §11.9 HIGH-B / R2).
 *
 * The InboundCodec's `parse` captures a handful of values that are STABLE for the whole request
 * lifecycle (they do NOT change across retries): the pre-sanitize truncation baseline, the reverse-leg
 * resanitize closure, the mutable `betaProbe` handle, and the client's `anthropic-beta` seed. The
 * CellAssembly's `buildStrategies` / `prepareWire` consume them.
 *
 * WHY a dedicated top-level envelope field (not `prepareHints`): `prepareHints` has **replace
 * semantics** — attempt 0 clears it and each retry's `RetryAction` fully overwrites it (pipeline.ts).
 * Threading request-lifecycle-stable state through `prepareHints` would let the FIRST hint-bearing retry
 * (e.g. `unsupported-beta` returning `{ excludeBetas }`) wipe the stable baseline → auto-truncate
 * under-truncates / prepareWire builds the wrong wire, and a mutable `betaProbe` handle in replace-
 * semantics is self-contradictory. So `requestState` sits ALONGSIDE `model` on the envelope (a `readonly`
 * field the shallow `with()` copy preserves by reference), separate from per-attempt `prepareHints`.
 *
 * Populated by the InboundCodec (C2+ as legs migrate); unset (`undefined`) until then. Fields are
 * Anthropic-leg-shaped today (the only leg with request-lifecycle-stable strategy supply); typed with
 * `import type` so this format-agnostic pipeline module never creates a runtime cycle.
 */

import type { BetaProbe } from "~/lib/anthropic/pipeline"
import type { PreprocessInfo } from "~/lib/history/types"
import type { ToolNameMapper } from "~/lib/tool-name-mapper"

/**
 * The stable, per-request supply the outbound-leg strategy assembly + wire prep read (R2). Every field
 * is optional: a leg that needs none carries `undefined`. Added to as legs migrate onto CellAssembly.
 */
export interface RequestState {
  /**
   * The pre-sanitize payload snapshot the auto-truncate baseline is measured against (stable across
   * retries — a retry mutates `env.body`, so the baseline must be captured once at parse). Format-native
   * (Anthropic `MessagesPayload` / CC `ChatCompletionsPayload`), kept opaque here.
   */
  readonly truncateBaseline?: unknown
  /**
   * The reverse-leg resanitize closure (re-runs the Anthropic sanitize chain on a re-derived payload).
   * A reverse `@messages` leg supplies it from the hub translator; the direct Anthropic leg from its codec.
   */
  readonly resanitize?: (payload: unknown) => unknown
  /**
   * The SHARED mutable beta probe: `prepareWire` records outbound betas into it per-attempt, and the
   * `unsupported-beta` strategy reads its candidates LAZILY at retry-handle time (RFC §11.2 R3 — reference
   * sharing + lazy read, NEVER a construct-time snapshot).
   */
  readonly betaProbe?: BetaProbe
  /** The client's inbound `anthropic-beta` header value (seeds the betaProbe candidate ranking). */
  readonly clientAnthropicBeta?: string
  /** The client's raw inbound headers (lowercased) for optional upstream passthrough (Anthropic wire prep reads it). */
  readonly clientRequestHeaders?: Record<string, string>
  /**
   * The initial (attempt-0) sanitization diagnostic the reverse/direct Anthropic leg produced at parse,
   * read back by the handler's pipelineInfo rebuild. Opaque here (Anthropic-shaped).
   */
  readonly initialSanitizationInfo?: unknown
  /** Route-supplied message-level preprocess info (the Anthropic sanitize rewrite + pipelineInfo rebuild read it). */
  readonly preprocessInfo?: PreprocessInfo
  /**
   * Client-original ↔ source-format mapper captured once at parse. Immutable across
   * retries; target-wire mappers compose from this stable provenance rather than
   * the mutable `ctx.toolNameMapper` that response restoration updates per attempt.
   */
  readonly sourceToolNameMapper?: ToolNameMapper | null
  /**
   * REVERSE `@messages` leg only: the shared `ReverseAnthropicMapperHolder` (kept opaque here — a pipeline
   * module can't import the openai-cc reverse-rewrite type without coupling). The leg's `requestRewrites`
   * (reverse sanitize) and `buildLegStrategies` (reverse resanitize) both read it, so it must be the SAME
   * per-request instance. A source codec's parse creates it (`createReverseAnthropicMapperHolder`).
   */
  readonly reverseMapperHolder?: unknown
  /**
   * openai-responses FALLBACK (`/chat`) leg only: the per-request fallback-exchange SCRATCH (RFC §11.2c —
   * responseId/itemId/resolvedModel/rebuiltMessages). Kept opaque here (openai-responses-shaped, and a
   * pipeline module can't import the codec's type). A shared MUTABLE holder both the CHAT leg (writes it in
   * `translateOut`, reads `rebuiltMessages` in `prepareWire`) and the openai-responses InboundCodec's render
   * side (reads ids/resolvedModel) reference — the same per-request instance the codec's parse creates. Built
   * LAZILY on the fallback route (never for a direct `/responses` request).
   */
  readonly responsesFallbackScratch?: unknown
}
