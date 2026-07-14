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
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RetryStrategy } from "~/lib/pipeline/types"

import { filterDelegatedStrategies } from "~/lib/anthropic/error-shaping"

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
