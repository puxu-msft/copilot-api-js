/**
 * Pure matcher predicates for GHC's illegal-thinking-layout 400s — the shared
 * decision core of the L2 reactive strip-all retry (docs/plan/thinking-quarantine,
 * docs/spec/2026-07-26-thinking-terminal-block-layout.md).
 *
 * This is a NEUTRAL Anthropic leaf (beside `stripAllThinking`) so BOTH retry
 * shells import it DOWNWARD: the v4 native strategy
 * (`~/lib/codec/anthropic/poisoned-thinking-retry`) and its legacy
 * `RetryStrategy<TPayload>` twin (`~/lib/request/strategies/poisoned-thinking-retry`).
 * Homing the matcher here rather than inside the codec layer avoids an inverted
 * request/strategies → codec dependency, while still keeping the two pipeline
 * paths from drifting on what counts as poisoned.
 *
 * Pure functions only — no state / ctx / payload reads or mutation.
 */

import type { ApiError } from "~/lib/error"

import { HTTPError } from "~/lib/error"

/**
 * Guarded match for the upstream 400s caused by an ILLEGAL THINKING LAYOUT in an
 * assistant message. Two empirically-confirmed shapes (see
 * docs/spec/2026-07-26-thinking-terminal-block-layout.md):
 *
 *   C1  "`thinking` or `redacted_thinking` blocks in the latest assistant message
 *        cannot be modified..."          — two adjacent thinking blocks
 *   C2  "The final block in an assistant message cannot be `thinking`."
 *                                        — message terminates on thinking
 *
 * Both are cured by the same remediation (strip ALL thinking and retry), which is
 * why they share one predicate. Each shape requires its own full cue, so this never
 * fires on unrelated 400s (e.g. `Extra inputs are not permitted`) nor on the legacy
 * `thinking.type.enabled` rejection (no "cannot be modified" phrase; owned by
 * `legacy-thinking-retry`).
 *
 * L1 (`destackAdjacentThinking`) proactively prevents BOTH shapes; this matcher only
 * gates the reactive fallback for layouts L1 did not preempt.
 */
export function isThinkingLayoutRejection(message: string): boolean {
  const lower = message.toLowerCase()
  if (lower.includes("cannot be modified")) return lower.includes("thinking") || lower.includes("redacted_thinking")
  // C2 is phrased without "cannot be modified"; require the full final-block cue so a
  // bare "thinking" mention elsewhere can never trigger a strip-all.
  return lower.includes("final block in an assistant message cannot be")
}

/**
 * Resolve the human-readable rejection message from a classified 400. The
 * classifier's `message` is usually the terse HTTPError message; the detailed
 * layout-rejection text lives in the raw response body. Try the classified
 * message first, then fall back to the raw HTTPError's JSON `error.message` (or
 * the raw text if it isn't JSON).
 *
 * Module-private: the only consumer is `matchesThinkingLayoutRejection` (no
 * external importer). Kept as a distinct function so the body-parse branch reads
 * clearly; it is exercised end-to-end through the public matcher's tests.
 */
function extractThinkingRejectMessage(error: ApiError): string | null {
  if (isThinkingLayoutRejection(error.message)) return error.message
  if (!(error.raw instanceof HTTPError)) return null
  const text = error.raw.responseText
  try {
    return (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text
  } catch {
    // Body isn't JSON — match against the raw text.
    return text
  }
}

/**
 * Error-level predicate: is this classified error one of the illegal-thinking-layout
 * 400s? Combines the class gate (`bad_request` / 400), the body-aware message
 * extraction, and the guarded phrase matcher into ONE decision shared by BOTH strategy
 * shells — the native env strategy and the legacy twin. Each shell ANDs its own
 * `state.stripThinkingOnReject` gate + per-request one-shot guard on top; keeping this
 * core in one place stops the two paths from drifting.
 */
export function matchesThinkingLayoutRejection(error: ApiError): boolean {
  if (error.type !== "bad_request" || error.status !== 400) return false
  const msg = extractThinkingRejectMessage(error)
  return msg ? isThinkingLayoutRejection(msg) : false
}
