/**
 * L2 buffered-retry hit-rate telemetry (RFC §10 / §8 decision data).
 *
 * A tiny in-memory aggregate counter of buffered-retry resolutions, exposed via
 * `/api/status.protect_streaming`. Supports the §8 "is mid-stream RST occasional
 * (→ keep L2) or inevitable-overbudget (→ prefer L1)" decision: the hit rate is
 * `success / (success + exhausted)`. Resets on restart (a live-observation counter,
 * not the durable 7-day usage history — per-entry detail already lives in history's
 * `attempts[]`). `recordFeature("protect-streaming-retry")` additionally tags each
 * entry for per-request querying.
 */

/** Resolution outcome of a buffered-retry generation. */
export type ProtectStreamingOutcome = "success" | "exhausted" | "retreated"

export interface ProtectStreamingStats {
  /** Committed a complete generation (possibly after ≥1 retry). */
  success: number
  /** All retries failed (transport-close / truncation) — surfaced as a stream error. */
  exhausted: number
  /** Buffer cap exceeded → retreated to live forwarding (lost L2 protection). */
  retreated: number
  /** Total retries consumed across all resolutions (a save = success with retries > 0). */
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
