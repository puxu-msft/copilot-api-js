/**
 * Backend read-side projections over a `HistoryEntry` (RFC 2026-07-07
 * history-data-model-restructure).
 *
 * The response/model signals live on the per-attempt `upstreamRequest` /
 * `upstreamResponse` legs and the `_index.derived` projection. P4c-3 removed the
 * legacy top-level legs (`outboundResponse` / `outboundRequest` / `effectiveRequest`
 * / `sseEvents`) and the deprecated top-level scalars (`attemptCount` /
 * `currentStrategy` / `failureReason`); a legacy DB row's OLD stages are mapped
 * into these new legs at read time by the serialize.ts adapter, so every consumer
 * reads the new legs uniformly (live rows and historical rows alike).
 */

import type {
  //
  HistoryEntry,
  UsageData,
} from "./types"

/** Non-nullable per-attempt shape (the element type of `HistoryEntry.attempts`). */
type Attempt = NonNullable<HistoryEntry["attempts"]>[number]

/** The final (most recent) attempt of an entry, if any attempts are present. */
export function finalAttempt(entry: Pick<HistoryEntry, "attempts">): Attempt | undefined {
  return entry.attempts?.at(-1)
}

/** The final settled attempt's upstream request leg (new model), if present. */
export function finalUpstreamRequest(entry: Pick<HistoryEntry, "attempts">): Attempt["upstreamRequest"] | undefined {
  return finalAttempt(entry)?.upstreamRequest
}

/** The final settled attempt's upstream response leg (new model), if present. */
export function finalUpstreamResponse(entry: Pick<HistoryEntry, "attempts">): Attempt["upstreamResponse"] | undefined {
  return finalAttempt(entry)?.upstreamResponse
}

/** Resolved model name of the upstream response (final attempt's `upstreamResponse.model`). */
export function resolveResponseModel(entry: Pick<HistoryEntry, "attempts">): string | undefined {
  return finalUpstreamResponse(entry)?.model
}

/**
 * Whether the upstream response succeeded: `_index.derived.responseSuccess`
 * (recompute-only projection) → final attempt's `upstreamResponse.success`.
 * `false` is preserved (nullish coalescing).
 */
export function resolveResponseSuccess(entry: Pick<HistoryEntry, "attempts" | "_index">): boolean | undefined {
  return entry._index?.derived?.responseSuccess ?? finalUpstreamResponse(entry)?.success
}

/** Upstream response usage (final attempt's `upstreamResponse.usage`). */
export function resolveResponseUsage(entry: Pick<HistoryEntry, "attempts">): UsageData | undefined {
  return finalUpstreamResponse(entry)?.usage
}

/** Upstream response stop reason (final attempt's `upstreamResponse.stopReason`). */
export function resolveStopReason(entry: Pick<HistoryEntry, "attempts">): string | undefined {
  return finalUpstreamResponse(entry)?.stopReason
}

/**
 * Response-side error message: the final attempt's `error` (the per-attempt error
 * home — `upstreamResponse` carries no error field). Callers that also want the
 * entry-level verdict append `?? entry._index?.derived?.failureReason` at the call site.
 */
export function resolveResponseError(entry: Pick<HistoryEntry, "attempts">): string | undefined {
  return finalAttempt(entry)?.error
}

/** Attempt count: `_index.derived.attemptCount` → live `attempts.length`. */
export function resolveAttemptCount(entry: Pick<HistoryEntry, "attempts" | "_index">): number | undefined {
  return entry._index?.derived?.attemptCount ?? entry.attempts?.length
}

/** Current strategy: `_index.derived.currentStrategy` → live final attempt's `strategy`. */
export function resolveCurrentStrategy(entry: Pick<HistoryEntry, "attempts" | "_index">): string | undefined {
  return entry._index?.derived?.currentStrategy ?? finalAttempt(entry)?.strategy
}
