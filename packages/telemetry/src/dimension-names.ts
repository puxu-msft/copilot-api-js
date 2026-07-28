/**
 * Telemetry dimension NAME registry — the entry/ctx-free half of the dimension registry.
 *
 * A dimension has two halves: WHAT it is called and how large its key space may grow (this file,
 * telemetry-domain-owned), and HOW to resolve a settled request's key for it (the extractors, which
 * must see `HistoryEntryData` / `RequestContextSnapshot` and therefore stay in core — see
 * `observability/telemetry-dimensions.ts`). The dimension registry's own module doc has always
 * described that separation ("registry type-light; the extractor knows entry/ctx"); this split
 * makes it a package boundary instead of a convention.
 *
 * The aggregation leaf (`request-telemetry.ts`) needs only this half — it accumulates against
 * resolved keys and never sees an entry — so keeping the names here is what lets the telemetry
 * package stop depending on `context/types`.
 *
 * Adding a dimension: add a spec HERE, then TypeScript forces the matching extractor in core (the
 * extractor table is a `Record` keyed by this file's name union — an absent extractor is a compile
 * error, not a silently-missing dimension).
 */

/**
 * Key-space size class. `bounded` = naturally small (a route enum, main/subagent) so every key is
 * tracked. `capped` = derived from CLIENT-controlled input (the raw requested model name, the
 * user-agent, tool names) and therefore potentially unbounded, so `request-telemetry` bounds the
 * key count per store and merges the overflow into `"other"`.
 */
export type TelemetryDimensionCardinality = "bounded" | "capped"

/** One registered dimension's name + key-space class — everything about a dimension that does not need an entry. */
export interface TelemetryDimensionSpec {
  readonly name: string
  readonly cardinality: TelemetryDimensionCardinality
}

/**
 * The registered dimensions. Order is irrelevant (keys are name-addressed). `model` is the
 * back-compat dimension projected to `RequestTelemetrySnapshot.modelsSinceStart` / `modelsLast7d`.
 *
 * `model` / `client` / `tool` / `refusal_category` are `capped` because their keys come from open
 * strings (the raw client model, user-agent, tool names, and the upstream-owned refusal category).
 * Any of those producers can introduce new values without a proxy release, so the key set must stay
 * bounded (memory leak + a `/metrics` cardinality bomb). Only `endpoint` (a route enum), `agentKind`
 * (`main`/`subagent`) and `max_tokens_truncation` (a fixed class enum) are genuinely `bounded` and
 * skip the cap.
 */
export const TELEMETRY_DIMENSION_SPECS = [
  { name: "model", cardinality: "capped" },
  { name: "endpoint", cardinality: "bounded" },
  { name: "client", cardinality: "capped" },
  { name: "agentKind", cardinality: "bounded" },
  { name: "tool", cardinality: "capped" },
  { name: "max_tokens_truncation", cardinality: "bounded" },
  { name: "refusal_category", cardinality: "capped" },
] as const satisfies ReadonlyArray<TelemetryDimensionSpec>

/** Every registered dimension name as a union — the compile-time key set the core extractor table must cover exhaustively. */
export type TelemetryDimensionName = (typeof TELEMETRY_DIMENSION_SPECS)[number]["name"]

/** The capped (high-cardinality) dimension names, passed to `recordSettledRequest` so it bounds their key counts. */
export const CAPPED_DIMENSION_NAMES: ReadonlySet<string> = new Set(
  TELEMETRY_DIMENSION_SPECS.filter((spec) => spec.cardinality === "capped").map((spec) => spec.name),
)

/** All registered dimension names — `/api/stats` validates the requested `dimension` against this list, `/metrics` iterates it. */
export const TELEMETRY_DIMENSION_NAMES: ReadonlyArray<string> = TELEMETRY_DIMENSION_SPECS.map((spec) => spec.name)

/**
 * Per-request tally of the assistant response's thinking blocks, split by content emptiness +
 * signature presence. Owned here rather than beside its extractor because it is a MEASURE INPUT
 * shape the aggregation leaf consumes (`SettledTelemetryInput.thinkingBlocks`), not an entry-shaped
 * type:
 * - `nonEmpty`      — `thinking` is a non-blank string (real reasoning text).
 * - `emptySigned`   — `thinking` blank but `signature` a non-empty string (normal encrypted /
 *   compat block — Anthropic thinking is self-contained in the signature).
 * - `emptyUnsigned` — `thinking` blank AND `signature` empty/missing/null (a corrupt double-empty
 *   block — the upstream-corruption signal `thinkingBlockSanitizeCheck.all_empty` strips).
 */
export interface ThinkingBlockCounts {
  nonEmpty: number
  emptySigned: number
  emptyUnsigned: number
}
