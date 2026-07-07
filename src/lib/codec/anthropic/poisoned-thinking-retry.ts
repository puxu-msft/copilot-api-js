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
 *
 * The shared match core (`matchesThinkingModifiedRejection`) lives in the neutral
 * `~/lib/anthropic/poisoned-thinking-match` leaf so the legacy twin
 * (`~/lib/request/strategies/poisoned-thinking-retry`) imports it DOWNWARD — no
 * request/strategies → codec inversion.
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

import { matchesThinkingModifiedRejection } from "~/lib/anthropic/poisoned-thinking-match"
import { stripAllThinking } from "~/lib/anthropic/strip-all-thinking"
import { state } from "~/lib/state"

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
      return matchesThinkingModifiedRejection(error)
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
