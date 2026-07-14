// RC3 behavior: a retry backoff must be interruptible by the stale reaper's lifecycleSignal,
// and once the request is being cancelled the driver must NOT start a new upstream attempt.
// (Regression guard for the 2800s overrun: a reaper-settled request kept sleeping through an
// exponential backoff and then started another attempt.)

import { describe, test, expect } from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RequestContext } from "~/lib/context/request"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { RetryStrategy } from "~/lib/pipeline/types"

import { createPipelineDriver } from "~/lib/pipeline/driver"

import { BASE, makeCodec, makeEnv, makeTransport } from "./hooks/driver-test-helpers"

// A ctx whose lifecycleSignal is driven by a real AbortController (reapInFlight aborts it),
// plus the no-op methods the driver touches on the retry path.
function makeReapableCtx(): { ctx: RequestContext; reap: () => void } {
  const ac = new AbortController()
  const ctx = {
    beginAttempt: () => {},
    transition: () => {},
    setAttemptError: () => {},
    recordAttemptFailure: () => {},
    setSseEvents: () => {},
    setHttpHeaders: () => {},
    setAttemptResponseHeaders: () => {},
    setRouteInfo: () => {},
    setAttemptEffectiveRequest: () => {},
    setAttemptWireRequest: () => {},
    addQueueWaitMs: () => {},
    get lifecycleSignal() {
      return ac.signal
    },
    reapInFlight: () => ac.abort(),
  } as unknown as RequestContext
  return { ctx, reap: () => ac.abort() }
}

// A strategy that always asks for a retry with a LONG backoff — so if the gate/abortableDelay
// were absent, the test would hang on the backoff (or spawn a 2nd attempt).
const alwaysRetryLongBackoff: RetryStrategy = {
  name: "test-always-retry",
  canHandle: (_e: ApiError) => true,
  handle: (_e: ApiError, env: RequestEnvelope) => Promise.resolve({ kind: "retry" as const, env, waitMs: 60_000 }),
}

describe("driver backoff — reaper cancel gate (RC3)", () => {
  test("reaper abort before retry → no new attempt, transport called exactly once", async () => {
    const { ctx, reap } = makeReapableCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })

    let calls = 0
    const transport = makeTransport(async () => {
      calls++
      // First (and only) attempt fails → triggers the retry path. Reap concurrently so the
      // attempt-boundary gate sees an aborted lifecycleSignal and refuses the next attempt.
      reap()
      throw new Error("upstream 500 (retryable)")
    })

    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: (e) => codec.decideRoute(e),
      transport,
      strategies: [alwaysRetryLongBackoff],
      maxRetries: 3,
    })

    // runRequest THROWS on exchange failure (ok:false is only for a route-reject decision).
    // The reaper-cancel gate throws before the 60s backoff / next attempt.
    await expect(driver.runRequest({ body: {}, headers: new Headers() })).rejects.toThrow(/abort/i)
    // The decisive assertion: exactly ONE upstream attempt despite maxRetries=3 and a strategy
    // that always wants to retry — the reaper's lifecycleSignal short-circuited the backoff.
    expect(calls).toBe(1)
  })
})
