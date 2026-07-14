/**
 * Unit tests for Phase 5's D-class self-heal delegation (`filterDelegatedStrategies`,
 * `src/lib/anthropic/error-shaping.ts`).
 *
 * `filterDelegatedStrategies` wraps a reactive `RetryStrategy[]` (the `assembleStrategiesForEndpoint`
 * output) so that a strategy configured `"delegate"` in `state.errorSelfhealDelegate` never fires —
 * the 400 it would otherwise have retried is instead let through to the client, where Claude Code's
 * own self-heal logic (thinking-signature strip / mid-conv-system / etc.) handles it. Only `canHandle`
 * is wrapped; `handle`/`onResolved` pass through unchanged. The wrapper never mutates the strategy
 * array's SHAPE (same length, same order) — only `"delegate"`-flagged entries get a wrapped
 * `canHandle`.
 *
 * Pure functions — no runtime, no I/O, no `~/lib/context/*` import (the `onDelegated` callback is
 * injected by the caller, which has `env.ctx.recordFeature`; see task 5.2's integration test for the
 * real wiring).
 *
 * Task 5.3 adds a second describe block — "D-class boundary invariants" — proving the delegation
 * mechanism's SCOPE against the real `buildAnthropicStrategies()` output (not `fakeStrategy` doubles):
 * (a) CC's client-side `retry:media-strip` self-heal leg has NO proxy-side reactive-strategy
 * counterpart, so a delegate config entry naming it is a structural no-op (delegate-only by design,
 * not a missing knob); (b) the always-on L1 thinking-signature quarantine pre-flight sanitize
 * (`createQuarantineProactiveFilter`, a `RequestRewrite` at `order: 250` registered in
 * `codec.ts`'s SEPARATE `requestRewrites` array) is structurally absent from the `RetryStrategy[]`
 * `filterDelegatedStrategies` operates on — delegation cannot reach it no matter what
 * `errorSelfhealDelegate` contains, in contrast with its reactive L2 fallback
 * (`poisoned-thinking-retry`), which IS a real, delegable `RetryStrategy`.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RetryStrategy } from "~/lib/pipeline/types"
import type { MessagesPayload } from "~/types/api/anthropic"

import { filterDelegatedStrategies } from "~/lib/anthropic/error-shaping"
import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { createQuarantineProactiveFilter } from "~/lib/anthropic/thinking-quarantine/proactive-filter"
import { buildAnthropicStrategies } from "~/lib/codec/anthropic/strategies"
import { setStateForTests } from "~/lib/state"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

function mk(type: string, status: number): ApiError {
  return { type: type as ApiError["type"], status, message: "boom", raw: null }
}

function fakeStrategy(name: string, matches: boolean): RetryStrategy {
  return {
    name,
    canHandle: () => matches,
    handle: async () => ({ kind: "abort" }) as never,
  }
}

describe("filterDelegatedStrategies", () => {
  test("delegate=proxy (default/omitted key) → canHandle behaviour unchanged", () => {
    const strategies = [fakeStrategy("system-reject-retry", true)]
    const filtered = filterDelegatedStrategies(strategies, {})
    expect(filtered[0]?.canHandle(mk("bad_request", 400))).toBe(true)
  })

  test('delegate="delegate" and the original canHandle would have matched → forced false', () => {
    const strategies = [fakeStrategy("system-reject-retry", true)]
    const filtered = filterDelegatedStrategies(strategies, { "system-reject-retry": "delegate" })
    expect(filtered[0]?.canHandle(mk("bad_request", 400))).toBe(false)
  })

  test('delegate="delegate" but the original canHandle would NOT have matched → still false, and onDelegated is NOT invoked', () => {
    const strategies = [fakeStrategy("system-reject-retry", false)]
    const hits: Array<string> = []
    const filtered = filterDelegatedStrategies(strategies, { "system-reject-retry": "delegate" }, (name) => hits.push(name))
    expect(filtered[0]?.canHandle(mk("bad_request", 400))).toBe(false)
    expect(hits).toEqual([])
  })

  test('delegate="delegate" and matched → onDelegated receives the strategy name, exactly once per canHandle call', () => {
    const strategies = [fakeStrategy("system-reject-retry", true)]
    const hits: Array<string> = []
    const filtered = filterDelegatedStrategies(strategies, { "system-reject-retry": "delegate" }, (name) => hits.push(name))
    filtered[0]?.canHandle(mk("bad_request", 400))
    expect(hits).toEqual(["system-reject-retry"])
  })

  test("delegate config has a key that matches no strategy .name → silently ignored, no throw, other strategies unaffected", () => {
    const strategies = [fakeStrategy("system-reject-retry", true)]
    expect(() => filterDelegatedStrategies(strategies, { "not-a-real-strategy": "delegate" })).not.toThrow()
    const filtered = filterDelegatedStrategies(strategies, { "not-a-real-strategy": "delegate" })
    expect(filtered[0]?.canHandle(mk("bad_request", 400))).toBe(true)
  })

  test("handle/onResolved pass through unchanged (only canHandle is wrapped)", () => {
    const strategies = [fakeStrategy("system-reject-retry", true)]
    const filtered = filterDelegatedStrategies(strategies, { "system-reject-retry": "delegate" })
    expect(filtered[0]?.handle).toBe(strategies[0]?.handle)
  })

  test("empty delegate map + empty strategy array → returns empty array", () => {
    expect(filterDelegatedStrategies([], {})).toEqual([])
  })

  test("mixed array: only the delegated entry is wrapped, others pass through by reference", () => {
    const kept = fakeStrategy("network-retry", true)
    const delegated = fakeStrategy("system-reject-retry", true)
    const filtered = filterDelegatedStrategies([kept, delegated], { "system-reject-retry": "delegate" })
    expect(filtered[0]).toBe(kept)
    expect(filtered[1]).not.toBe(delegated)
    expect(filtered[0]?.canHandle(mk("bad_request", 400))).toBe(true)
    expect(filtered[1]?.canHandle(mk("bad_request", 400))).toBe(false)
  })
})

describe("D-class boundary invariants (Task 5.3) — real buildAnthropicStrategies() output", () => {
  useIsolatedRuntime()

  const baselinePayload: MessagesPayload = { model: "claude-x", max_tokens: 128, messages: [] }
  /** Identity resanitize stub — a no-op `AnthropicSanitizeFn` (adapters need one, but never exercise it here). */
  const stubResanitize = (payload: MessagesPayload) => ({ payload, blocksRemoved: 0, systemReminderRemovals: 0 })

  const realStrategies = () =>
    buildAnthropicStrategies({
      originalPayload: baselinePayload,
      resanitize: stubResanitize,
      model: undefined,
      maxRetries: 3,
      betaProbe: createBetaProbe(undefined),
    })

  test("CC's client-side media-strip self-heal leg has no proxy-side reactive-strategy counterpart (delegate-only boundary)", () => {
    const strategies = realStrategies()
    // No strategy .name is media-strip-flavoured — CC's `retry:media-strip` self-heal leg has nothing
    // on the proxy side to delegate FROM. A delegate config entry naming it is therefore a structural
    // no-op (nothing to suppress), not a missing/broken config knob.
    const mediaRelated = strategies.filter((s) => /media/i.test(s.name))
    expect(mediaRelated).toEqual([])

    // filterDelegatedStrategies with a made-up media-strip key changes nothing: same length, same
    // names, in order — proving there is genuinely nothing to accidentally suppress.
    const filtered = filterDelegatedStrategies(strategies, { "media-strip-retry": "delegate" })
    expect(filtered.map((s) => s.name)).toEqual(strategies.map((s) => s.name))
  })

  test("the always-on L1 thinking-quarantine pre-flight sanitize is NOT a member of the RetryStrategy[] filterDelegatedStrategies operates on", () => {
    const strategies = realStrategies()
    // `thinking-quarantine-proactive` (src/lib/anthropic/thinking-quarantine/proactive-filter.ts:100-103)
    // is a `RequestRewrite` (order: 250), registered in codec.ts's SEPARATE `requestRewrites` array
    // (codec.ts:218) — a completely different pipeline stage from this `RetryStrategy[]`. It cannot
    // appear here by construction, so `filterDelegatedStrategies` (which only wraps THIS array's
    // entries) structurally cannot reach it no matter what `errorSelfhealDelegate` contains.
    expect(strategies.some((s) => s.name === "thinking-quarantine-proactive")).toBe(false)
    // Sanity: the L1 filter factory really does produce that RequestRewrite name/shape (not a
    // RetryStrategy) — confirming what "structurally cannot appear" is being asserted against.
    const l1 = createQuarantineProactiveFilter()
    expect(l1.name).toBe("thinking-quarantine-proactive")
    expect(l1.order).toBe(250)
    expect((l1 as unknown as Partial<RetryStrategy>).canHandle).toBeUndefined()

    // Contrast: L1's reactive L2 fallback (`poisoned-thinking-retry`) IS a real RetryStrategy in this
    // array — it's legitimately delegable. Delegating it forces canHandle false regardless of a real
    // "cannot be modified" match, proving delegation's REACH is exactly "the RetryStrategy[] array",
    // no more (can't touch L1) and no less (can reach every real reactive strategy, including this one).
    expect(strategies.some((s) => s.name === "poisoned-thinking-retry")).toBe(true)
    setStateForTests({ stripThinkingOnReject: true })
    const filtered = filterDelegatedStrategies(strategies, { "poisoned-thinking-retry": "delegate" })
    const l2 = filtered.find((s) => s.name === "poisoned-thinking-retry")
    const poisonedThinkingError: ApiError = { type: "bad_request", status: 400, message: "thinking blocks cannot be modified", raw: null }
    expect(l2?.canHandle(poisonedThinkingError)).toBe(false)
  })
})
