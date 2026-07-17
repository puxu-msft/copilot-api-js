/**
 * Task 5.1 (docs/plan/2026-07-12-upstream-hook-middleware/plan-5-integration-closeout.md) — the
 * CORE MOTIVATION acceptance test: does mounting `mockUpstreamError.toolFieldRejection()` on
 * `exchange` really drive the REAL reactive retry leg end-to-end, or does it just look like it
 * from the hook's own vantage point?
 *
 * Independent oracle (review H3, non-self-validating): the hook never asserts anything about
 * itself. Instead this test reads back the REAL persisted history entry (`~/lib/history`'s
 * `getEntry`, the same read path History Web UI/`/api/history` use) and checks the DRIVER's own
 * bookkeeping — `entry.attempts.length >= 2`, attempt 0's `upstreamResponse.status === 400` +
 * `rawBody` matching the injected tool-field text, attempt 1's `strategy ===
 * "tool-field-rejection-retry"` (the REAL production strategy name, not a stand-in) — plus the
 * strategy's own endpoint-wide learning side effect (`getUnsupportedToolFields()`). None of this
 * is written by the hook; it's the driver's `RequestContext.toHistoryEntry()` → history sink →
 * SQLite (in-memory) → `getEntry` round-trip, the exact machinery a real request goes through.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { getUnsupportedToolFields } from "~/lib/anthropic/feature-negotiation"
import { HTTPError } from "~/lib/error"
import { getEntry } from "~/lib/history"
import {
  //
  resetUpstreamHook,
  setUpstreamHookForTests,
} from "~/lib/pipeline/hooks/loader"
import { mockUpstreamError } from "~/lib/pipeline/hooks/toolkit"

import { useIsolatedRuntime } from "../../helpers/isolated-fixture"
import { okStream } from "./driver-test-helpers"
import {
  //
  anthropicRawRequest,
  anthropicToolBody,
  makeCountingTransport,
  makeRealAnthropicDriver,
  seedAnthropicModel,
} from "./real-anthropic-driver-helpers"

describe("Task 5.1 — reactive retry leg end-to-end (mockUpstreamError.toolFieldRejection → real tool-field-rejection-retry strategy)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    resetUpstreamHook()
  })
  afterEach(() => {
    resetUpstreamHook()
  })

  test("a hook-mocked 400 tool-field rejection on attempt 1 is handled by the REAL strategy; attempt 2 succeeds — verified via getEntry(), not the hook's self-report", async () => {
    seedAnthropicModel("claude-x")

    let onExchangeCalls = 0
    setUpstreamHookForTests({
      exchange: async (_wire, _env, next) => {
        onExchangeCalls++
        if (onExchangeCalls === 1) mockUpstreamError.toolFieldRejection()
        return next()
      },
    })
    const { transport, sendCount } = makeCountingTransport(() => okStream())
    const driver = makeRealAnthropicDriver(transport)

    const result = await driver.runRequest(anthropicRawRequest(anthropicToolBody("claude-x")))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The hook's own call count (sanity — not the oracle itself).
    expect(onExchangeCalls).toBe(2)
    // Real transport was reached exactly ONCE (attempt 2 — the retry). Attempt 1 never got past
    // the hook's injected throw, so `next()` (== transport.send) was never called for it.
    expect(sendCount()).toBe(1)

    // Settle the ctx (mirrors the handler's post-stream `ctx.complete()`) so the terminal
    // `attempts` projection actually lands on the persisted entry — an in-flight (not yet
    // terminal) entry's `attempts` field is empty until completion (only activity fields mirror
    // incrementally; `toHistoryEntry`'s full attempts array is written at complete()/fail()).
    result.env.ctx.complete({ success: true, model: "claude-x", usage: { input_tokens: 1, output_tokens: 1 }, content: "ok" })

    // ── Independent oracle: the REAL persisted history entry, not the hook / driver call log. ──
    const entry = getEntry(result.env.ctx.id)
    expect(entry).toBeDefined()
    if (!entry) return
    expect(entry.attempts).toBeDefined()
    const attempts = entry.attempts ?? []
    expect(attempts.length).toBeGreaterThanOrEqual(2)

    const first = attempts[0]
    const second = attempts[1]
    expect(first?.upstreamResponse?.status).toBe(400)
    expect(first?.upstreamResponse?.rawBody).toContain("Extra inputs are not permitted")
    expect(first?.upstreamResponse?.rawBody).toContain("eager_input_streaming")
    // The REAL production strategy recorded itself on the RETRY attempt it produced — proof the
    // driver's generic strategy-lookup loop matched the ACTUAL `tool-field-rejection-retry`
    // strategy (registered in `buildAnthropicStrategies`), not a test stand-in.
    expect(second?.strategy).toBe("tool-field-rejection-retry")

    // Cross-check: the strategy's own endpoint-wide learning side effect fired for real (not just
    // claimed by its return value) — `eager_input_streaming` is now fixated for future requests.
    expect(getUnsupportedToolFields()).toContain("eager_input_streaming")
  })

  test("a hook-mocked rejection for a field the strategy does NOT recognize never retries (canHandle correctly says no) — negative control proving the strategy is doing REAL parsing, not a rubber stamp", async () => {
    seedAnthropicModel("claude-x")

    let onExchangeCalls = 0
    setUpstreamHookForTests({
      exchange: async () => {
        onExchangeCalls++
        // A 400 that looks nothing like ANY reactive-rejection pattern this strategy stack knows.
        throw new HTTPError("unrelated failure", 400, "totally unrelated body text")
      },
    })
    const { transport, sendCount } = makeCountingTransport(() => okStream())
    const driver = makeRealAnthropicDriver(transport)

    // No strategy claims this error → the driver rethrows (S4 exhausted with no matching handler,
    // driver.ts:359 `if (!strategy) throw error`) — `runRequest` REJECTS, it does not return `{ok:false}`
    // (that shape is reserved for the S2 route-reject branch).
    await expect(driver.runRequest(anthropicRawRequest(anthropicToolBody("claude-x")))).rejects.toThrow()
    // Only ever hit the hook once — no retry loop was ever entered because nothing "handled" it.
    expect(onExchangeCalls).toBe(1)
    expect(sendCount()).toBe(0)
  })
})
