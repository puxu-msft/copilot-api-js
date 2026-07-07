/**
 * L2 reactive strip-all retry — the second layer of the three-layer fix for
 * GHC's "thinking ... cannot be modified" 400 (docs/plan/thinking-quarantine).
 *
 * L1 (`destackAdjacentThinking`) proactively prevents the common adjacency-poison
 * case. This L2 strategy is the reactive fallback: when a "thinking ... cannot be
 * modified" 400 still reaches S4 (a non-adjacency poison mode L1 did not preempt),
 * it strips ALL thinking blocks from the payload and retries once to unblock the
 * turn. L3 (Phase 3) will proactively quarantine ahead of the request.
 *
 * Implemented as a NATIVE env-based strategy (not wrapped by
 * `adaptLegacyStrategy`): L3 later reads `env.ctx` in `onResolved`, which the
 * legacy adapter drops. The remediation itself is payload-only (strip-all
 * thinking) so it needs no ctx here.
 */

import type { ApiError } from "~/lib/error"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
// review C2: the env-based strategy interface is exported as `RetryStrategy` by
// pipeline/types (aliased here to `EnvRetryStrategy` for readability); the
// envelope type lives in pipeline/envelope.
import type {
  //
  RetryAction,
  RetryStrategy as EnvRetryStrategy,
} from "~/lib/pipeline/types"
import type { MessagesPayload } from "~/types/api/anthropic"

import { stripAllThinking } from "~/lib/anthropic/strip-all-thinking"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

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
 */
function extractMessage(error: ApiError): string | null {
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
 * Reactive fallback for the "thinking ... cannot be modified" 400 that L1 de-stack
 * did not preempt. Per-request one-shot (the `attempted` closure guard) and gated
 * by `state.stripThinkingOnReject` — a single blunt strip-all-and-retry to unblock
 * the turn, no escalation.
 */
export function createPoisonedThinkingRetryStrategy(): EnvRetryStrategy {
  let attempted = false
  return {
    name: "poisoned-thinking-retry",
    canHandle(error: ApiError): boolean {
      if (attempted) return false
      if (!state.stripThinkingOnReject) return false
      if (error.type !== "bad_request" || error.status !== 400) return false
      const msg = extractMessage(error)
      return msg ? isThinkingModifiedRejection(msg) : false
    },
    handle(error: ApiError, env: RequestEnvelope): Promise<RetryAction> {
      attempted = true
      const payload = env.body as MessagesPayload
      const { messages, strippedCount } = stripAllThinking(payload.messages)
      // Nothing to strip → the 400 is not actually about echoed thinking we can
      // remove; abort rather than retry an unchanged payload into the same 400.
      if (strippedCount === 0) return Promise.resolve({ kind: "abort", error })
      // review M1: `env.with()` is the only immutable-update method (envelope.ts:108);
      // a bare `{ ...env }` spread would drop the prototype method + shared ctx.
      const nextEnv = env.with({ body: { ...payload, messages } })
      return Promise.resolve({ kind: "retry", env: nextEnv, learning: true, meta: { strippedThinkingOnReject: strippedCount } })
    },
  }
}
