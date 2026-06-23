/**
 * Telemetry dimension registry (sink layer).
 *
 * A dimension is a registered key-extractor over a settled request's `entry` (+
 * `ctx`, for ctx-derived dimensions like cost in a later phase). The sink computes
 * the per-dimension keys HERE — where the entry/ctx types are in scope — and hands
 * `request-telemetry.ts` a plain `Record<dimName, key | null>`, keeping that
 * aggregation leaf type-light (it never imports entry/ctx, only the resolved keys).
 *
 * Adding a dimension (endpoint / client / agentKind / tool / …) is one push to
 * {@link TELEMETRY_DIMENSIONS}; record/persist/load/snapshot in request-telemetry
 * are all generic over dimension names, so no edits there.
 *
 * **`null` semantics**: an extractor returning `null` means "not applicable to this
 * request" → the request is NOT counted under that dimension. Per-dimension request
 * totals may therefore legitimately differ (e.g. a future `tool` dimension only
 * counts requests that invoked a tool). The `model` dimension never returns `null`
 * (falls back to `"unknown"`), so its total always equals the settled-request count.
 * Empty/whitespace keys are normalized to `"unknown"` by request-telemetry.
 */

import type { HistoryEntryData } from "~/lib/context/types"
import type { RequestContextSnapshot } from "~/lib/observability/events"

/** A registered telemetry dimension: a name + an entry/ctx → key extractor. */
export interface StatDimension {
  name: string
  /** Resolve this request's key for the dimension. `null` = not applicable (skip). */
  extract: (entry: HistoryEntryData, ctx: RequestContextSnapshot) => string | null
}

/**
 * The registered dimensions. Order is irrelevant (keys are name-addressed).
 * Phase 1 registers only `model` (the back-compat dimension projected to
 * `RequestTelemetrySnapshot.modelsSinceStart` / `modelsLast7d`).
 */
export const TELEMETRY_DIMENSIONS: ReadonlyArray<StatDimension> = [
  { name: "model", extract: (entry) => entry.outboundResponse?.model ?? entry.inboundRequest.model ?? "unknown" },
]

/** Resolve every registered dimension's key for one settled request. */
export function extractTelemetryKeys(entry: HistoryEntryData, ctx: RequestContextSnapshot): Record<string, string | null> {
  const keys: Record<string, string | null> = {}
  for (const dim of TELEMETRY_DIMENSIONS) keys[dim.name] = dim.extract(entry, ctx)
  return keys
}
