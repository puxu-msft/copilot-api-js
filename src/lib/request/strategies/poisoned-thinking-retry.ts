/**
 * Legacy-shape twin of the L2 poisoned-thinking strip-all retry.
 *
 * The env-native strategy (`~/lib/codec/anthropic/poisoned-thinking-retry`)
 * serves the v4 driver path (direct /v1/messages — the main traffic). This twin
 * is its legacy `RetryStrategy<TPayload>` counterpart for the legacy
 * `executeRequestPipeline` — specifically the web_search double-hop orchestrator,
 * which replays poisoned assistant history through the SAME "thinking ... cannot
 * be modified" 400 and needs the same strip-all unblock.
 *
 * It reuses the SAME matcher (`matchesThinkingModifiedRejection`, from the neutral
 * `~/lib/anthropic/poisoned-thinking-match` leaf) and the SAME remediation
 * (`stripAllThinking`) as the native strategy, so the two paths cannot drift on
 * what counts as poisoned or how it is cleared. It also flags the retry
 * `learning: true` for the same anti-starvation reason as the native path.
 *
 * The legacy pipeline has NO `env.ctx`, so there is NO L3 session-quarantine
 * commit here — consistent with the spec's "no session → degrade" (L3 landing is
 * Task 10, v4-only). This twin is a blunt strip-all-and-retry only.
 */

import type { ApiError } from "~/lib/error"
import type { MessageParam } from "~/types/api/anthropic"

import { matchesThinkingModifiedRejection } from "~/lib/anthropic/poisoned-thinking-match"
import { stripAllThinking } from "~/lib/anthropic/strip-all-thinking"
import { state } from "~/lib/state"

import type {
  //
  RetryAction,
  RetryContext,
  RetryStrategy,
} from "../pipeline"

/**
 * Reactive fallback for the "thinking ... cannot be modified" 400 on the legacy
 * pipeline. Per-request one-shot (the `attempted` closure guard) and gated by
 * `state.stripThinkingOnReject` — a single blunt strip-all-and-retry to unblock
 * the turn, no escalation.
 */
export function createLegacyPoisonedThinkingRetryStrategy<TPayload extends { messages: Array<MessageParam> }>(): RetryStrategy<TPayload> {
  let attempted = false
  return {
    name: "poisoned-thinking-retry",

    canHandle(error: ApiError): boolean {
      if (attempted) return false
      if (!state.stripThinkingOnReject) return false
      return matchesThinkingModifiedRejection(error)
    },

    handle(error: ApiError, currentPayload: TPayload, _context: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      attempted = true
      const { messages, strippedCount } = stripAllThinking(currentPayload.messages)
      // Nothing to strip → the 400 is not actually about echoed thinking we can
      // remove; abort rather than retry an unchanged payload into the same 400.
      if (strippedCount === 0) return Promise.resolve({ action: "abort", error })
      return Promise.resolve({
        action: "retry",
        payload: { ...currentPayload, messages },
        // `learning: true` — draw from the separate learning budget (parity with
        // the native path) so this web_search strip-all corrective retry can't be
        // starved under a normal-retry pileup that has exhausted `maxRetries`.
        learning: true,
        meta: { strippedThinkingOnReject: strippedCount },
      })
    },
  }
}
