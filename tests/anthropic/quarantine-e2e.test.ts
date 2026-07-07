/**
 * Three-layer thinking-quarantine — end-to-end COMPOSITION guards (Task 12).
 *
 * Prior tasks unit-tested each layer in ISOLATION: L1 de-stack terminal-order
 * (`destack-terminal-order.test.ts`), L2 strip-all retry registration
 * (`poisoned-thinking-retry-wiring.test.ts`), the L3 store
 * (`thinking-quarantine-store.test.ts`), the L3 `onResolved` commit
 * (`quarantine-onresolved.test.ts`), and the L3 proactive filter alone
 * (`quarantine-proactive-filter.test.ts`, `order === 250 < 300`). What NONE of
 * them prove is that the layers COMPOSE — that when assembled and run together the
 * way the driver's `runRewriteIn` does, they cooperate rather than corrupt each
 * other. That interaction is what this file locks, using ONLY constructible seams:
 * the REAL codec request rewrites + directly-invoked strategy `onResolved`, each
 * given an injected temp-dir store (DI — never the real `~/.local/share`).
 *
 * Guard A — driver-level ordering over the REAL rewrites: `assembleRequestRewrites`
 *   sorts L3 (`thinking-quarantine-proactive`, order 250) strictly BEFORE L1
 *   (`anthropic-sanitize`, order 300) even when registered in the reverse array
 *   position — proving execution order is the sorted `.order`, not insertion order.
 *
 * Guard B — the load-bearing L3×L1 interaction: a quarantined conversation whose
 *   turn carries ADJACENT thinking. Run through the assembled chain, L3 strip-all
 *   (250) fires first, so L1 de-stack (300) sees no thinking → it is a NO-OP and
 *   leaves NO orphan synthetic separator. The CONTRAST case (same payload + same
 *   de-stack strategy, but NOT quarantined) proves the marker's absence is CAUSED
 *   by L3: there, L3 no-ops, de-stack fires, and the synthetic separator DOES
 *   appear + both thinking blocks survive. Reverse the order (de-stack first, then
 *   strip) and the quarantined case would orphan an inserted marker — spec §3.4.
 *
 * Guard C — the cross-turn producer→consumer loop with a SHARED injected store:
 *   turn 1's reactive L2 strip-all retry succeeds, so its L3 `onResolved` commit
 *   quarantines `(session, agent)`; turn 2 (same session) then runs the assembled
 *   L3+L1 chain and is proactively stripped — the exact self-heal a full HTTP
 *   round-trip performs, minus the wire 400/200 (already covered by the L2 http
 *   tests). Proves the PRODUCER (`onResolved`) and CONSUMER (proactive filter)
 *   agree on the `(session, agent)` key format across the loop.
 *
 * DEFERRED (needs a production seam we deliberately do NOT invent here): a full
 * Hono-app e2e driving a real 400→L2-retry→200 through the singleton store. That
 * path resolves `getQuarantineStore()` (a lazy process singleton with NO
 * `resetForTests` seam, not registered in isolated-fixture RESETTERS), so it can't
 * be pointed at a temp store hermetically without cross-test singleton pollution.
 * Root seam already tracked in docs/todo/deferred-backlog.md (the web_search-path
 * L3 integration test shares this exact blocker).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  mkdtempSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  RequestRewrite,
} from "~/lib/pipeline/rewrite-registry"
import type {
  //
  MessageParam,
  MessagesPayload,
} from "~/types/api/anthropic"

import { SYNTHETIC_THINKING_SEPARATOR } from "~/lib/anthropic/sanitize/destack-adjacent-thinking"
import { createQuarantineProactiveFilter } from "~/lib/anthropic/thinking-quarantine/proactive-filter"
import { ThinkingQuarantineStore } from "~/lib/anthropic/thinking-quarantine/store"
import { createPoisonedThinkingRetryStrategy } from "~/lib/codec/anthropic/poisoned-thinking-retry"
import { createAnthropicSanitizeRewrite } from "~/lib/codec/anthropic/request-rewrite-adapter"
import { assembleRequestRewrites } from "~/lib/pipeline/rewrite-registry"
import { setStateForTests } from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

autoRestoreState()

// Content-block factories (mirror strip-all-thinking / proactive-filter tests):
// empty-string thinking + a signature — this exact shape survives the full
// sanitize chain (see destack-terminal-order.test.ts), so de-stack is the ONLY
// thing that would touch two adjacent copies of it.
const think = (sig: string) => ({ type: "thinking", thinking: "", signature: sig })
const text = (t: string) => ({ type: "text", text: t })

// The two REAL codec request rewrites, each given the injected store. The sanitize
// rewrite's per-request deps are the no-op minimum its `apply` reads: a zero
// PreprocessInfo + a swallow-only `onInitialSanitizationInfo` (the write-back the
// codec closure needs in production — irrelevant to composition ordering).
function realRewrites(store: ThinkingQuarantineStore): { l3: RequestRewrite; l1: RequestRewrite } {
  return {
    l3: createQuarantineProactiveFilter({ store }),
    l1: createAnthropicSanitizeRewrite({
      preprocessInfo: { strippedReadTagCount: 0, dedupedToolCallCount: 0 },
      onInitialSanitizationInfo: () => {},
    }),
  }
}

/**
 * Minimal envelope exercising exactly the surface the two rewrites read: L3 reads
 * `clientFormat`, `ctx.{sessionId,agentId}`, `body.messages`; L1 reads
 * `clientFormat`, `ctx.{toolNameMapper,setPipelineInfo}`, `body`. `with` spreads
 * `this` (the more-correct immutable-update, matching the wiring test) so a chain
 * threads body patches through correctly.
 */
function makeEnv(opts: { sessionId?: string; agentId?: string; messages: Array<unknown> }): RequestEnvelope {
  const body = { model: "claude-opus-4.8", max_tokens: 100, messages: opts.messages } as unknown as MessagesPayload
  const env = {
    clientFormat: "anthropic" as const,
    ctx: {
      sessionId: opts.sessionId,
      agentId: opts.agentId,
      toolNameMapper: null,
      setPipelineInfo: () => {},
    },
    body,
    with(this: RequestEnvelope, patch: { body?: unknown }) {
      return { ...this, ...patch } as unknown as RequestEnvelope
    },
  }
  return env as unknown as RequestEnvelope
}

/**
 * Mirror the driver's S3 `runRewriteIn` VERBATIM (driver.ts:166): assemble the
 * chain (filter + sort by `.order`) and apply each in declared order, threading
 * the envelope. This is the composition-under-test — NOT a re-implementation.
 */
function runRewriteIn(rewrites: ReadonlyArray<RequestRewrite>, env: RequestEnvelope): RequestEnvelope {
  let current = env
  for (const rewrite of assembleRequestRewrites(current, rewrites)) {
    current = rewrite.apply(current).env
  }
  return current
}

// Independent oracles over the FINAL body.
function thinkingTypesIn(messages: Array<MessageParam>): Array<string> {
  return messages
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string }>) : []))
    .map((b) => b.type)
    .filter((t) => t === "thinking" || t === "redacted_thinking")
}
function hasSyntheticMarker(messages: Array<MessageParam>): boolean {
  const isMarker = (b: { type: string; text?: string }): boolean => b.type === "text" && b.text === SYNTHETIC_THINKING_SEPARATOR
  return messages.some((m) => Array.isArray(m.content) && (m.content as Array<{ type: string; text?: string }>).some(isMarker))
}
function messagesOf(env: RequestEnvelope): Array<MessageParam> {
  return (env.body as MessagesPayload).messages
}

let dir: string
let store: ThinkingQuarantineStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tsq-e2e-"))
  store = new ThinkingQuarantineStore(join(dir, "q.db"), () => 72 * 3600_000)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("Guard A — driver-level ordering over the REAL codec rewrites", () => {
  test("assembleRequestRewrites sorts L3(250) before L1(300) regardless of registration order", () => {
    const { l3, l1 } = realRewrites(store)
    // Register L1 FIRST (reverse of execution order) to prove sort — not array
    // position — decides; this is exactly what codec.ts hands the driver, but
    // deliberately shuffled so a position-based bug would surface.
    const chain = assembleRequestRewrites(makeEnv({ sessionId: "s1", messages: [] }), [l1, l3])
    expect(chain.map((r) => r.name)).toEqual(["thinking-quarantine-proactive", "anthropic-sanitize"])
    expect(l3.order).toBe(250)
    expect(l1.order).toBe(300)
    expect(l3.order).toBeLessThan(l1.order)
  })
})

describe("Guard B — L3×L1 interaction: proactive strip-all makes de-stack a no-op (no orphan markers)", () => {
  // insert_text so de-stack WOULD insert a VISIBLE synthetic separator on any
  // surviving adjacency — makes the "no marker" assertion load-bearing.
  test("quarantined conversation with ADJACENT thinking → final body has NO thinking AND NO synthetic marker", () => {
    setStateForTests({ poisonedThinkingQuarantine: true, thinkingDestackStrategy: "insert_text" })
    store.record({ sessionId: "s1", agentId: "" }, "thinking cannot be modified")
    const { l3, l1 } = realRewrites(store)

    // Two ADJACENT thinking blocks — the exact adjacency de-stack exists to split.
    const env = makeEnv({ sessionId: "s1", messages: [{ role: "assistant", content: [think("a"), think("b"), text("hi")] }] })
    const out = messagesOf(runRewriteIn([l1, l3], env))

    expect(thinkingTypesIn(out)).toEqual([]) // strip-all (L3) won — nothing left
    expect(hasSyntheticMarker(out)).toBe(false) // de-stack (L1) saw nothing → no orphan marker
  })

  test("CONTRAST — same payload + strategy but NOT quarantined → L3 no-op, de-stack fires: thinking preserved + synthetic marker present", () => {
    setStateForTests({ poisonedThinkingQuarantine: true, thinkingDestackStrategy: "insert_text" })
    // store is EMPTY — this (session) is not quarantined, so L3 is a no-op and L1
    // de-stack is what runs. Proves the marker's absence above is CAUSED by L3.
    const { l3, l1 } = realRewrites(store)

    const env = makeEnv({ sessionId: "s1", messages: [{ role: "assistant", content: [think("a"), think("b"), text("hi")] }] })
    const out = messagesOf(runRewriteIn([l1, l3], env))

    expect(thinkingTypesIn(out)).toEqual(["thinking", "thinking"]) // both preserved
    expect(hasSyntheticMarker(out)).toBe(true) // de-stack inserted a separator between them
  })
})

describe("Guard C — cross-turn producer→consumer loop (L2 onResolved commit → next-turn L3 proactive), shared store", () => {
  test("turn 1 L2 strip-all success commits quarantine → turn 2 same session is proactively stripped, no marker", () => {
    setStateForTests({ poisonedThinkingQuarantine: true, stripThinkingOnReject: true, thinkingDestackStrategy: "insert_text" })

    // ── Turn 1: the reactive L2 strip-all retry ultimately resolved the turn. The
    // driver calls THIS strategy's onResolved with the retry meta; it durably
    // quarantines (session, agent) in the SHARED store. (The wire 400→retry→200 is
    // covered by streaming-l2-*.http.test.ts; onResolved IS the driver commit hook.)
    const strategy = createPoisonedThinkingRetryStrategy({ store })
    const turn1Env = { ctx: { sessionId: "s1", agentId: undefined } } as unknown as RequestEnvelope
    strategy.onResolved?.(turn1Env, { strippedThinkingOnReject: 1 })
    // Independent oracle — the producer wrote the key the consumer will look up.
    expect(store.isPoisoned({ sessionId: "s1", agentId: "" })).toBe(true)

    // ── Turn 2: a fresh turn on the SAME session carrying adjacent thinking, run
    // through the assembled L3+L1 chain reading the SAME store. L3 proactively
    // strips (conversation is quarantined), so there is no self-inflicted 400 and
    // de-stack is a no-op.
    const { l3, l1 } = realRewrites(store)
    const turn2 = makeEnv({ sessionId: "s1", messages: [{ role: "assistant", content: [think("c"), think("d"), text("again")] }] })
    const out = messagesOf(runRewriteIn([l1, l3], turn2))

    expect(thinkingTypesIn(out)).toEqual([]) // proactively stripped across the turn boundary
    expect(hasSyntheticMarker(out)).toBe(false) // de-stack no-op → no orphan marker
    expect(store.isPoisoned({ sessionId: "s1", agentId: "" })).toBe(true) // still quarantined (slid on hit)
  })

  test("un-committed session is NOT quarantined → turn 2 keeps its thinking (loop is closed by the commit, not ambient)", () => {
    setStateForTests({ poisonedThinkingQuarantine: true, stripThinkingOnReject: true, thinkingDestackStrategy: "insert_text" })
    // No onResolved commit for s2 → the consumer must NOT strip it.
    const { l3, l1 } = realRewrites(store)
    const turn2 = makeEnv({ sessionId: "s2", messages: [{ role: "assistant", content: [think("c"), think("d"), text("again")] }] })
    const out = messagesOf(runRewriteIn([l1, l3], turn2))

    expect(thinkingTypesIn(out)).toEqual(["thinking", "thinking"]) // untouched by L3; de-stacked by L1
    expect(hasSyntheticMarker(out)).toBe(true)
    expect(store.isPoisoned({ sessionId: "s2", agentId: "" })).toBe(false)
  })
})
