/**
 * Pure matcher predicates for GHC's "thinking ... cannot be modified" 400 — the
 * shared decision core of the L2 reactive strip-all retry
 * (docs/plan/thinking-quarantine).
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
 * Guarded match for the "thinking blocks ... cannot be modified" 400. Requires
 * BOTH the "cannot be modified" cue AND a thinking-block token, so it never
 * fires on unrelated 400s (e.g. `Extra inputs are not permitted`) nor on the
 * legacy `thinking.type.enabled` rejection (which has no "cannot be modified"
 * phrase and is owned by `legacy-thinking-retry`).
 */
export function isThinkingModifiedRejection(message: string): boolean {
  const lower = message.toLowerCase()
  if (!lower.includes("cannot be modified")) return false
  return lower.includes("thinking") || lower.includes("redacted_thinking")
}

/**
 * Resolve the human-readable rejection message from a classified 400. The
 * classifier's `message` is usually the terse HTTPError message; the detailed
 * `... cannot be modified ...` text lives in the raw response body. Try the
 * classified message first, then fall back to the raw HTTPError's JSON
 * `error.message` (or the raw text if it isn't JSON).
 *
 * Module-private: the only consumer is `matchesThinkingModifiedRejection` (no
 * external importer). Kept as a distinct function so the body-parse branch reads
 * clearly; it is exercised end-to-end through the public matcher's tests.
 */
function extractThinkingRejectMessage(error: ApiError): string | null {
  if (isThinkingModifiedRejection(error.message)) return error.message
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
 * Error-level predicate: is this classified error the "thinking ... cannot be
 * modified" 400? Combines the class gate (`bad_request` / 400), the body-aware
 * message extraction, and the guarded phrase matcher into ONE decision shared by
 * BOTH strategy shells — the native env strategy and the legacy twin. Each shell
 * ANDs its own `state.stripThinkingOnReject` gate + per-request one-shot guard on
 * top; keeping this core in one place stops the two paths from drifting.
 */
export function matchesThinkingModifiedRejection(error: ApiError): boolean {
  if (error.type !== "bad_request" || error.status !== 400) return false
  const msg = extractThinkingRejectMessage(error)
  return msg ? isThinkingModifiedRejection(msg) : false
}
