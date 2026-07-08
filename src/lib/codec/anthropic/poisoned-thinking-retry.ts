/**
 * L2 reactive strip-all retry — the second layer of the three-layer fix for
 * GHC's "thinking ... cannot be modified" 400 (docs/plan/thinking-quarantine).
 *
 * L1 (`destackAdjacentThinking`) proactively prevents the common adjacency-poison
 * case. This L2 strategy is the reactive fallback: when a "thinking ... cannot be
 * modified" 400 still reaches S4 (a non-adjacency poison mode L1 did not preempt),
 * it strips ALL thinking blocks from the payload and retries once to unblock the
 * turn. L3 (this file's `onResolved`) then durably quarantines the offending
 * `(session, agent)` conversation so a later turn is stripped proactively (Task 11).
 *
 * Implemented as a NATIVE env-based strategy (not wrapped by
 * `adaptLegacyStrategy`): L3's `onResolved` reads `env.ctx.{sessionId,agentId}`,
 * which the legacy adapter drops. The remediation itself is payload-only (strip-all
 * thinking) so it needs no ctx here.
 *
 * The shared match core (`matchesThinkingModifiedRejection`) lives in the neutral
 * `~/lib/anthropic/poisoned-thinking-match` leaf so the legacy twin
 * (`~/lib/request/strategies/poisoned-thinking-retry`) imports it DOWNWARD — no
 * request/strategies → codec inversion.
 */

import type { ThinkingQuarantineStore } from "~/lib/anthropic/thinking-quarantine/store"
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
import { getQuarantineStore } from "~/lib/anthropic/thinking-quarantine"
import { toQuarantineKey } from "~/lib/anthropic/thinking-quarantine/session-key"
import { state } from "~/lib/state"

/**
 * Reactive fallback for the "thinking ... cannot be modified" 400 that L1 de-stack
 * did not preempt. Per-request one-shot (the `attempted` closure guard) and gated
 * by `state.stripThinkingOnReject` — a single blunt strip-all-and-retry to unblock
 * the turn, no escalation.
 *
 * L3 (`onResolved`) closes the loop: when THIS strategy's strip-all retry is what
 * ultimately unblocked the turn, it durably remembers the `(session, agent)` pair
 * so a later turn of the same conversation gets proactively stripped ahead of the
 * request (Task 11), instead of paying the reactive 400+retry round-trip again.
 *
 * `deps.store` is a test seam (inject a temp-dir store); production omits it and
 * the commit falls through to the lazy process singleton `getQuarantineStore()`.
 */
export function createPoisonedThinkingRetryStrategy(deps?: { store?: ThinkingQuarantineStore }): EnvRetryStrategy {
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
      // `errorSample` (richest-data-flow) rides the retry meta → onResolved → the
      // store's `last_error_sample` diagnostic column. `strippedThinkingOnReject`
      // is the load-bearing signal onResolved gates on (OUR strip-all, not another
      // strategy's retry that merely happened to succeed later).
      return Promise.resolve({ kind: "retry", env: nextEnv, learning: true, meta: { strippedThinkingOnReject: strippedCount, errorSample: error.message } })
    },
    /**
     * Commit-on-success (L3). The driver invokes this ONLY when the retry this
     * strategy produced resolved the turn, threading that retry's `meta`. Gated on:
     *   - `state.poisonedThinkingQuarantine` — the L3 master switch (hot-reloadable,
     *     re-read per commit), AND
     *   - `meta.strippedThinkingOnReject` — proof OUR strip-all caused the success,
     *     AND
     *   - a resolvable `(session, agent)` key — no `session_id` → cannot remember a
     *     conversation across turns, so degrade to a silent no-op.
     */
    onResolved(env: RequestEnvelope, meta?: Record<string, unknown>): void {
      if (!state.poisonedThinkingQuarantine) return
      if (!meta?.strippedThinkingOnReject) return
      const key = toQuarantineKey(env.ctx.sessionId, env.ctx.agentId)
      if (!key) return
      // `meta.errorSample` is `unknown` off the opaque meta bag — take it only when
      // it is actually a string (handle sets it to `error.message`); anything else
      // degrades to the constant rather than recording "[object Object]".
      const sample = typeof meta.errorSample === "string" ? meta.errorSample : "thinking cannot be modified"
      ;(deps?.store ?? getQuarantineStore()).record(key, sample)
    },
  }
}
