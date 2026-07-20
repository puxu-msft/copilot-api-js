import {
  //
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "bun:test"

import { createRequestContextManager } from "~/lib/context/manager"
import {
  //
  setStateForTests,
  state,
} from "~/lib/state"

import { waitUntil } from "../helpers/wait-until"

// C4b: a per-request HARD deadline (`state.requestDeadline`) enforced by a precise per-request
// timer — fires ON TIME regardless of the periodic stale-reaper scan cadence (which fires late,
// RC2). On fire it applies the same cancel(reapInFlight) + settle(fail) as the reaper.

describe("request_deadline hard total-duration cap (C4b)", () => {
  let origDeadline: number
  beforeEach(() => {
    origDeadline = state.requestDeadline
  })
  afterEach(() => {
    setStateForTests({ requestDeadline: origDeadline })
  })

  test("a per-request timer cancels + fails a request that outlives request_deadline", async () => {
    setStateForTests({ requestDeadline: 0.05 })
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    ctx.setOriginalRequest({ model: "test-model", messages: [], stream: true, payload: {} })

    expect(ctx.settled).toBe(false)
    expect(ctx.lifecycleSignal.aborted).toBe(false)

    await waitUntil(() => ctx.settled, { label: "request to hit hard deadline" })

    expect(ctx.settled).toBe(true)
    // Cancel got teeth: lifecycleSignal aborted (reapInFlight) so an in-flight fetch/backoff stops.
    expect(ctx.lifecycleSignal.aborted).toBe(true)
    expect(ctx.cancelled).toBe(true)
    expect(ctx.cancelReason).toBe("request_deadline")
    // No longer tracked as active.
    expect(manager.activeCount).toBe(0)
  })

  test("request_deadline=0 disables the timer (request is NOT force-failed)", async () => {
    setStateForTests({ requestDeadline: 0 })
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    ctx.setOriginalRequest({ model: "test-model", messages: [], stream: true, payload: {} })

    await new Promise((r) => setTimeout(r, 80))
    expect(ctx.settled).toBe(false) // no deadline armed → still in flight
    expect(ctx.lifecycleSignal.aborted).toBe(false)
    ctx.fail("test-model", new Error("cleanup"))
  })

  test("inspection manager (armDeadlineTimers:false) never arms a deadline (dry-run exemption)", async () => {
    setStateForTests({ requestDeadline: 0.05 })
    const manager = createRequestContextManager({ armDeadlineTimers: false })
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    ctx.setOriginalRequest({ model: "test-model", messages: [], stream: true, payload: {} })

    await new Promise((r) => setTimeout(r, 80))
    expect(ctx.settled).toBe(false) // exempt → not force-failed despite a 0.05s deadline
    ctx.fail("test-model", new Error("cleanup"))
  })

  test("settling before the deadline clears the timer (no post-settle force-fail)", async () => {
    setStateForTests({ requestDeadline: 0.05 })
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    ctx.setOriginalRequest({ model: "test-model", messages: [], stream: true, payload: {} })
    // Settle immediately (normal completion) — the deadline timer must be cleared, not fire later.
    ctx.complete({ success: true, model: "test-model", usage: { input_tokens: 1, output_tokens: 1 }, content: null })
    expect(ctx.settled).toBe(true)
    await new Promise((r) => setTimeout(r, 80))
    // Still settled via complete (not overwritten by a deadline fail) — settled-guard + cleared timer.
    expect(ctx.state).toBe("completed")
  })
})
