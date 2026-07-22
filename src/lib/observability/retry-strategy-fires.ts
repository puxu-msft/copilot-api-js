/**
 * Per-strategy retry-fire telemetry counter (RFC 2026-07-21-retry-strategy-registry §3.5 / plan Task 5).
 *
 * A tiny process-lifetime in-memory aggregate — mirrors `anthropic/tool-input-repair-stats.ts` /
 * `anthropic/protect-streaming-stats.ts` (a live-observation counter, resets on restart, NOT persisted).
 * Complements the existing per-request `recordAttemptFailure({nextStrategy})` (already lands "which
 * strategy fired" into history, `src/lib/context/request.ts:2064`) with a cross-request AGGREGATE the
 * history line can't cheaply answer ("how many times has `network-retry` fired since boot?").
 *
 * Open counters bag (skill `telemetry-architecture` §一 支柱2): `Map<string, number>`, no fixed key
 * set — a strategy name never registered here before just starts at 0 on first fire. `/metrics`
 * (`metrics-exposition.ts`) fans out over whatever keys are present, so adding a 17th registry entry
 * needs zero edits here.
 *
 * Keyed by the retry-registry entry's `.name` (e.g. `"network-retry"`), NOT its `configKey` (e.g.
 * `"network"`) — this is the SAME identifier space `recordAttemptFailure({nextStrategy})` already
 * writes into history, so a `/metrics` reader and a history search on `nextStrategy` line up on the
 * same string without a lookup table.
 */

let fires = new Map<string, number>()

/** Record one retry-strategy fire (called at the driver's budget-accepted retry commit point). */
export function recordRetryStrategyFire(strategyName: string): void {
  fires.set(strategyName, (fires.get(strategyName) ?? 0) + 1)
}

/** Snapshot the current per-strategy fire counts (a fresh object — mutating it never affects the live counter). */
export function getRetryStrategyFireCounts(): Readonly<Record<string, number>> {
  return Object.fromEntries(fires)
}

/** Test-only: reset the module-global counter (registered in RESETTERS). */
export function resetRetryStrategyFiresForTests(): void {
  fires = new Map()
}
