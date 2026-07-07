/**
 * Backend read-side projections over a `HistoryEntry` (RFC 2026-07-07
 * history-data-model-restructure, P4a consumer migration).
 *
 * The restructure moves the authoritative response/model signals OFF the
 * deprecated top-level legs (`outboundResponse` / `outboundRequest` /
 * `effectiveRequest` / `sseEvents`) ONTO the per-attempt `upstreamRequest` /
 * `upstreamResponse` legs and the `_index.derived` projection. During migration
 * BOTH coexist (the producer dual-writes), so every read here is
 * "new leg ?? legacy top-level" — the new leg wins for live entries (populated by
 * the P2.5/P2.6 producer alignment), and a legacy-only entry (e.g. the P0 golden
 * fixtures, or a pre-restructure persisted row) falls back byte-identically.
 *
 * Centralizing the fallback chains HERE (single shared primitive — the project's
 * "fix all comparison sites / abstract one primitive" discipline) means P4c's
 * legacy-leg removal is a ONE-FILE edit: drop the `?? entry.outboundResponse…`
 * (and legacy-top-level) arms below and every consumer is migrated at once.
 *
 * NOTE — sibling read-side consumers NOT covered here because they operate on the
 * `HistoryEntryData` (context/types) type world, not `HistoryEntry`:
 *   - `src/lib/observability/telemetry-dimensions.ts` (model dimension + content
 *     extractors)
 *   - `src/lib/observability/sinks/telemetry.ts` (settled success/usage)
 * Those inline the same "new ?? legacy" fallback with a `P4c` marker comment.
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

/** Resolved model name of the upstream response: new leg → legacy `outboundResponse.model`. */
export function resolveResponseModel(entry: Pick<HistoryEntry, "attempts" | "outboundResponse">): string | undefined {
  return finalUpstreamResponse(entry)?.model ?? entry.outboundResponse?.model
}

/**
 * Whether the upstream response succeeded: `_index.derived.responseSuccess`
 * (recompute-only projection) → final attempt's `upstreamResponse.success` →
 * legacy `outboundResponse.success`. `false` is preserved (nullish coalescing).
 */
export function resolveResponseSuccess(entry: Pick<HistoryEntry, "attempts" | "outboundResponse" | "_index">): boolean | undefined {
  return entry._index?.derived?.responseSuccess ?? finalUpstreamResponse(entry)?.success ?? entry.outboundResponse?.success
}

/** Upstream response usage: new leg → legacy `outboundResponse.usage`. */
export function resolveResponseUsage(entry: Pick<HistoryEntry, "attempts" | "outboundResponse">): UsageData | undefined {
  return finalUpstreamResponse(entry)?.usage ?? entry.outboundResponse?.usage
}

/** Upstream response stop reason: new leg `stopReason` → legacy `outboundResponse.stop_reason`. */
export function resolveStopReason(entry: Pick<HistoryEntry, "attempts" | "outboundResponse">): string | undefined {
  return finalUpstreamResponse(entry)?.stopReason ?? entry.outboundResponse?.stop_reason
}

/**
 * Response-side error message: the final attempt's `error` (the new per-attempt
 * error home — `upstreamResponse` carries no error field) → legacy
 * `outboundResponse.error`. Callers that also want the entry-level verdict append
 * `?? entry.failureReason` at the call site (unchanged by P4c).
 */
export function resolveResponseError(entry: Pick<HistoryEntry, "attempts" | "outboundResponse">): string | undefined {
  return finalAttempt(entry)?.error ?? entry.outboundResponse?.error
}

/** Attempt count: `_index.derived.attemptCount` → legacy top-level `attemptCount`. */
export function resolveAttemptCount(entry: Pick<HistoryEntry, "attempts" | "_index" | "attemptCount">): number | undefined {
  return entry._index?.derived?.attemptCount ?? entry.attemptCount
}

/** Current strategy: `_index.derived.currentStrategy` → legacy top-level `currentStrategy`. */
export function resolveCurrentStrategy(entry: Pick<HistoryEntry, "_index" | "currentStrategy">): string | undefined {
  return entry._index?.derived?.currentStrategy ?? entry.currentStrategy
}
