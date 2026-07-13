/**
 * L3 proactive strip-all filter — the CONSUMER side of the durable thinking
 * quarantine (the PRODUCER is the strip-all retry's `onResolved` commit, Task 10).
 *
 * Before a request goes upstream, if its `(session, agent)` conversation is a
 * known-poisoned one still within TTL, strip ALL `thinking` blocks proactively
 * and slide the TTL — so the conversation never re-hits GHC's "thinking cannot be
 * modified" 400 (which would otherwise force the reactive L2 strip-all retry
 * round-trip on EVERY subsequent turn).
 *
 * Shipped as an env-aware `RequestRewrite` at `order: 250`, strictly BELOW
 * `ORDER_SANITIZE` (300, the L1 de-stack sanitize; request-rewrite-adapter.ts).
 * Execution order is by the sorted `.order` key, NOT array position
 * (rewrite-registry §3). Running strip-all BEFORE de-stack means a quarantined
 * turn has no thinking left, so de-stack is a no-op and leaves no orphan synthetic
 * markers. The reverse order would de-stack first (inserting synthetic markers)
 * and then strip the thinking, orphaning those markers — so `250` is load-bearing
 * (spec §3.4 / review C4).
 *
 * Coverage: the driver assembles this via the codec's `requestRewrites`. The
 * shared core ({@link stripAllThinkingIfQuarantined}) is exposed for direct reuse.
 */

import type {
  //
  RequestRewrite,
  RewriteResult,
} from "~/lib/pipeline/rewrite-registry"
import type {
  //
  MessageParam,
  MessagesPayload,
} from "~/types/api/anthropic"

import { stripAllThinking } from "~/lib/anthropic/strip-all-thinking"
import { ENDPOINT } from "~/lib/models/endpoint"
import { state } from "~/lib/state"

import type { ThinkingQuarantineStore } from "./store"

import { getQuarantineStore } from "./index"
import { toQuarantineKey } from "./session-key"

/** Optional test DI for {@link createQuarantineProactiveFilter}. */
export interface QuarantineProactiveFilterDeps {
  /** Override the durable store (tests point it at a temp dir); production omits → lazy singleton. */
  store?: ThinkingQuarantineStore
}

/** Outcome of {@link stripAllThinkingIfQuarantined}. */
export interface QuarantineStripResult {
  /** The (possibly rewritten) messages — the SAME array reference when unchanged (zero-copy). */
  messages: Array<MessageParam>
  /** True iff the conversation was quarantined AND at least one thinking block was stripped. */
  changed: boolean
}

/**
 * The shared L3 decision, format-agnostic (reused by the driver filter below): if
 * `(sessionId, agentId)` is a known-poisoned conversation within TTL, strip ALL
 * thinking and slide the TTL.
 *
 * Gating (in order — each a short-circuit no-op):
 *   1. `state.poisonedThinkingQuarantine` — the L3 master switch (hot-reloadable), then
 *   2. a resolvable key (`toQuarantineKey` → `null` without a sessionId → cannot
 *      quantify across turns → no-op), then
 *   3. `store.isPoisoned(key)` — cache-only, live-TTL read.
 *
 * The store is resolved LAZILY (`getQuarantineStore()`) only AFTER gates 1-2 pass,
 * NOT as an eager default parameter — so a feature-off or session-less request
 * never builds the SQLite sidecar. On a hit it ALWAYS `touch`es (slides the TTL
 * for this seen-again turn) BEFORE the `strippedCount === 0` check: a poisoned
 * conversation whose current turn happens to carry no thinking is still active, so
 * its quarantine must not be allowed to lapse. Returns `changed: false` (zero-copy)
 * whenever nothing was stripped.
 */
export function stripAllThinkingIfQuarantined(
  messages: Array<MessageParam>,
  sessionId: string | undefined,
  agentId: string | undefined,
  storeOverride?: ThinkingQuarantineStore,
): QuarantineStripResult {
  if (!state.poisonedThinkingQuarantine) return { messages, changed: false }
  const key = toQuarantineKey(sessionId, agentId)
  if (!key) return { messages, changed: false }
  // Lazy: only build/resolve the durable store once the gates above pass.
  const store = storeOverride ?? getQuarantineStore()
  if (!store.isPoisoned(key)) return { messages, changed: false }
  const { messages: stripped, strippedCount } = stripAllThinking(messages)
  store.touch(key) // slide TTL on hit (review H3) — before the count check: seen-again keeps it alive
  if (strippedCount === 0) return { messages, changed: false }
  return { messages: stripped, changed: true }
}

/**
 * Build the L3 proactive strip-all `RequestRewrite`. `deps.store` overrides the
 * durable store for tests; production omits it and the shared core falls through
 * to the lazy process singleton.
 */
export function createQuarantineProactiveFilter(deps?: QuarantineProactiveFilterDeps): RequestRewrite {
  return {
    name: "thinking-quarantine-proactive",
    order: 250, // review C4: execution order is by sorted `.order`, NOT array position; must be < ORDER_SANITIZE(300)
    // Two-axis gate (RFC 2026-07-11-anthropic-via-openai-translation §3.1 / §7.1): this proactive
    // filter strips poisoned thinking blocks from the UPSTREAM Anthropic `/v1/messages` request wire,
    // so — like the other Anthropic-wire request/response rewrites — it gates on the OUTBOUND leg
    // (`targetEndpoint`), not the inbound `clientFormat`. Byte-identical in Phase 1 (anthropic-direct
    // has both axes co-true); on the future reverse leg (cc/responses/gemini→/v1/messages) it fires
    // on the Anthropic wire regardless of inbound format, and NOT on the forward anthropic→cc leg.
    appliesTo: (env) => env.targetEndpoint === ENDPOINT.MESSAGES,
    apply(env): RewriteResult {
      const payload = env.body as MessagesPayload
      const { messages, changed } = stripAllThinkingIfQuarantined(payload.messages, env.ctx.sessionId, env.ctx.agentId, deps?.store)
      if (!changed) return { env, changed: false }
      // review M1: env.with() is the only immutable-update method (NOT a bare spread).
      return { env: env.with({ body: { ...payload, messages } }), changed: true }
    },
  }
}
