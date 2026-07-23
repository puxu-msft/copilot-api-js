/**
 * L2 buffered-retry hit-rate telemetry (RFC §10 / §8 decision data), keyed PER VENDOR.
 *
 * A tiny in-memory aggregate counter of L2 ENGAGEMENTS (NOT every buffered request) — exposed
 * per-vendor via `/api/status.protect_streaming`. A handler only records here when L2 actually did
 * something: a `success` AFTER ≥1 retry (a real save), an `exhausted` (all retries RST), a
 * `retreated` (buffer cap), or a `partial-degrade` (block-level: a boundary block committed live,
 * then the stream truncated). A clean first-try buffered commit (no RST, retries 0) is the silent
 * happy path and is NOT counted — otherwise every 200 would inflate `success`.
 *
 * hit rate (§8, {@link protectStreamingHitRate}) folds `partialDegrade` into the DENOMINATOR:
 * `success / (success + exhausted + partialDegrade)` — a partial-degrade is a partial success
 * (some committed content reached the client), so it belongs alongside the fully-saved and the
 * fully-lost engagements; `retreated` is excluded (it abandoned L2 protection entirely, not a
 * generation outcome). Resets on restart (a live-observation counter, not the durable 7-day usage
 * history — per-entry detail already lives in history's `attempts[]`).
 * `recordFeature("protect-streaming-retry")` tags the same engagements.
 */

// The outcome union is OWNED by the pipeline driver (its buffered sink produces these labels); this
// telemetry consumer re-exports it so the counter's keys can never drift from the producer contract.
export type { ProtectStreamingOutcome } from "~/lib/pipeline/types"

import type { ProtectStreamingOutcome } from "~/lib/pipeline/types"

export interface ProtectStreamingStats {
  /** Committed a complete generation AFTER ≥1 retry — an RST that L2 transparently saved. */
  success: number
  /** All retries failed (transport-close / truncation) — surfaced as a stream error. */
  exhausted: number
  /** Buffer cap exceeded → retreated to live forwarding (lost L2 protection). */
  retreated: number
  /**
   * Block-level path only: a boundary block was already committed live, then the stream truncated
   * (un-retryable — the committed prefix is on the wire). A graceful degrade distinct from
   * `exhausted` (which committed nothing).
   */
  partialDegrade: number
  /**
   * Continuation path only (spec 2026-07-22): the retry engine engaged AFTER the first block committed
   * — a synthetic continuation turn was re-dispatched but retries were exhausted before the generation
   * finished. Distinct from `exhausted` (which never committed) and `partial-degrade` (which never
   * attempted continuation): here continuation WAS tried but did not save.
   */
  continuationExhausted: number
  /** Total retries consumed across all engagements (every leg). */
  totalRetries: number
  /**
   * Retries consumed before a `partial-degrade` specifically — so the "the retry engine engaged
   * (and produced a committed prefix)" signal is not lost inside `totalRetries` (spec §9.2 M-1).
   */
  retriesBeforeDegrade: number
  /**
   * Retries consumed BEFORE the first block committed (pre-first-block transparent retries). Split from
   * {@link continuationRetries} so telemetry can tell whether a save came from transparent retry vs
   * continuation (telemetry-architecture: irreducible factors kept finest). `totalRetries =
   * preFirstBlockRetries + continuationRetries`.
   */
  preFirstBlockRetries: number
  /** Retries consumed AFTER the first block committed (continuation re-dispatches). */
  continuationRetries: number
}

const emptyStats = (): ProtectStreamingStats => ({
  success: 0,
  exhausted: 0,
  retreated: 0,
  partialDegrade: 0,
  continuationExhausted: 0,
  totalRetries: 0,
  retriesBeforeDegrade: 0,
  preFirstBlockRetries: 0,
  continuationRetries: 0,
})

/** Per-vendor engagement counters (vendor = `anthropic` / `responses` / `chat_completions` / `responses_ws`). */
let byVendor: Record<string, ProtectStreamingStats> = {}

/** Map an outcome label to its counter field (camelCase remaps for the hyphenated labels). */
const keyOf = (o: ProtectStreamingOutcome): keyof ProtectStreamingStats =>
  o === "partial-degrade" ? "partialDegrade" : o === "continuation-exhausted" ? "continuationExhausted" : o

/**
 * Record one buffered-retry resolution under `meta.vendor`. `retries` = total re-exchanges consumed for
 * this generation (folded into `totalRetries`, and into `retriesBeforeDegrade` for a `partial-degrade`).
 * `meta.continuationRetries` (default 0) is the subset consumed AFTER the first block committed; the
 * remainder is attributed to `preFirstBlockRetries`.
 */
export function recordProtectStreamingOutcome(outcome: ProtectStreamingOutcome, retries: number, meta: { vendor: string; continuationRetries?: number }): void {
  const s = (byVendor[meta.vendor] ??= emptyStats())
  s[keyOf(outcome)] += 1
  s.totalRetries += retries
  const contRetries = meta.continuationRetries ?? 0
  s.continuationRetries += contRetries
  s.preFirstBlockRetries += retries - contRetries
  if (outcome === "partial-degrade") s.retriesBeforeDegrade += retries
}

/**
 * §8 hit rate for one vendor's bucket: `success / (success + exhausted + partialDegrade +
 * continuationExhausted)`. `null` when the denominator is 0 (no scoreable engagements yet — e.g. only
 * retreats), so callers can render "n/a" instead of a misleading 0.
 */
export function protectStreamingHitRate(s: ProtectStreamingStats): number | null {
  const denom = s.success + s.exhausted + s.partialDegrade + s.continuationExhausted
  return denom === 0 ? null : s.success / denom
}

/** Snapshot the current per-vendor counters (deep copy — for `/api/status`). */
export function getProtectStreamingStats(): Record<string, ProtectStreamingStats> {
  return Object.fromEntries(Object.entries(byVendor).map(([v, s]) => [v, { ...s }]))
}

/** Test seam: drop all vendor buckets. */
export function resetProtectStreamingStatsForTests(): void {
  byVendor = {}
}
