/**
 * Retry-chain GIVE-UP telemetry — the missing counterpart of `retry-strategy-fires.ts`.
 *
 * The fire counter answers "which strategy rescued a turn"; nothing answered "which turns nobody
 * rescued". Every give-up path in the driver's semantic-retry policy used to `return { kind: "fail" }`
 * silently, so an upstream rejection whose wording NO strategy recognised produced exactly zero
 * signal on our side — the operator learned about it only when a client surfaced the raw 400.
 * That is how both illegal-layout incidents were found (2026-07-26 C2, 2026-07-27 C3): a human
 * pasted the error. See docs/spec/2026-07-26-thinking-terminal-block-layout.md.
 *
 * Four give-up reasons, all terminal for the turn:
 *   - `unclaimed`         no strategy's `canHandle` matched — we did not even understand the error.
 *                         The loudest one: it means our matchers have drifted from upstream's wording.
 *   - `strategy-abort`    a strategy claimed the error, then declined to retry (e.g. the payload is
 *                         not repairable by its remedy). Expected sometimes, but a rising count means
 *                         a matcher claims more than it can cure.
 *   - `strategy-threw`    the handler itself threw (also warned at the call site).
 *   - `budget-exhausted`  retries were available and used up (`maxRetries` / `maxLearningRetries`).
 *
 * Keyed by `(reason, errorType)` where `errorType` is the CLASSIFIER's bounded enum (`bad_request`,
 * `rate_limit`, …) — never the error message, whose cardinality is unbounded. The pair is stored in
 * one map under a NUL-joined key (NUL occurs in neither component) and split back apart for the
 * structured snapshot, so `/metrics` emits two real labels instead of one fused string.
 *
 * Process-lifetime, in-memory, resets on restart — same class as `retry-strategy-fires.ts` /
 * `anthropic/tool-input-repair-stats.ts`, NOT persisted telemetry.
 */

export type RetryGiveUpReason = "unclaimed" | "strategy-abort" | "strategy-threw" | "budget-exhausted"

export interface RetryGiveUpCount {
  reason: RetryGiveUpReason
  /** The classified error's `type` (bounded enum), e.g. `bad_request`. `unknown` when unclassified. */
  errorType: string
  count: number
}

/** NUL joiner: occurs in neither a reason literal nor the classifier's error-type enum. */
const SEP = "\u0000"

let giveUps = new Map<string, number>()

/** Record one terminal give-up of the retry chain (called at every `kind: "fail"` site in the driver). */
export function recordRetryGiveUp(reason: RetryGiveUpReason, errorType: string | undefined): void {
  const key = `${reason}${SEP}${errorType ?? "unknown"}`
  giveUps.set(key, (giveUps.get(key) ?? 0) + 1)
}

/** Snapshot as structured rows (a fresh array — mutating it never affects the live counter). */
export function getRetryGiveUpCounts(): ReadonlyArray<RetryGiveUpCount> {
  return [...giveUps].map(([key, count]) => {
    const sep = key.indexOf(SEP)
    return { reason: key.slice(0, sep) as RetryGiveUpReason, errorType: key.slice(sep + 1), count }
  })
}

/** Test-only: reset the module-global counter (registered in RESETTERS). */
export function resetRetryGiveUpsForTests(): void {
  giveUps = new Map()
}
