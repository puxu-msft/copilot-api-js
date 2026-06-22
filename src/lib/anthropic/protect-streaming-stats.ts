/**
 * L2 buffered-retry hit-rate telemetry (RFC §10 / §8 decision data).
 *
 * A tiny in-memory aggregate counter of L2 ENGAGEMENTS (NOT every buffered request) — exposed via
 * `/api/status.protect_streaming`. The handler only records here when L2 actually did something:
 * a `success` AFTER ≥1 retry (a real save), an `exhausted` (all retries RST), or a `retreated`
 * (buffer cap). A clean first-try buffered commit (no RST, retries 0) is the silent happy path and
 * is NOT counted — otherwise every 200 would inflate `success`. So `success` here means "RST hit,
 * retry saved it", and the §8 hit rate is `success / (success + exhausted)`. Resets on restart (a
 * live-observation counter, not the durable 7-day usage history — per-entry detail already lives in
 * history's `attempts[]`). `recordFeature("protect-streaming-retry")` tags the same engagements.
 */

/** Resolution outcome of a buffered-retry generation. */
export type ProtectStreamingOutcome = "success" | "exhausted" | "retreated"

export interface ProtectStreamingStats {
  /** Committed a complete generation AFTER ≥1 retry — an RST that L2 transparently saved. */
  success: number
  /** All retries failed (transport-close / truncation) — surfaced as a stream error. */
  exhausted: number
  /** Buffer cap exceeded → retreated to live forwarding (lost L2 protection). */
  retreated: number
  /** Total retries consumed across all engagements. */
  totalRetries: number
}

const stats: ProtectStreamingStats = { success: 0, exhausted: 0, retreated: 0, totalRetries: 0 }

/** Record one buffered-retry resolution. `retries` = re-exchanges consumed for this generation. */
export function recordProtectStreamingOutcome(outcome: ProtectStreamingOutcome, retries: number): void {
  stats[outcome] += 1
  stats.totalRetries += retries
}

/** Snapshot the current counters (for `/api/status`). */
export function getProtectStreamingStats(): ProtectStreamingStats {
  return { ...stats }
}

/** Test seam: reset the counters. */
export function resetProtectStreamingStatsForTests(): void {
  stats.success = 0
  stats.exhausted = 0
  stats.retreated = 0
  stats.totalRetries = 0
}
