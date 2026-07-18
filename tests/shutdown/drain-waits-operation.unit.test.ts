import {
  //
  describe,
  test,
  expect,
} from "bun:test"

import { createRequestContextManager } from "~/lib/context/manager"
import {
  //
  drainActiveRequests,
  type ShutdownDrainSource,
} from "~/lib/shutdown"

// C5 drain-switch: the shutdown drain waits on the OPERATION registry (quiesce), not just the
// visible registry (settle). A settled-but-not-quiesced request keeps orphan settle-before work
// (fetch/backoff) that must be drained — the exact gap behind the user's "why doesn't it show in
// drain" question. Proven here with a manager-backed tracker (same source the default tracker uses).

describe("shutdown drain waits on operation quiesce (C5 drain-switch)", () => {
  test("drain does NOT complete while a settled ctx has pending operation-body work", async () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    let release!: () => void
    ctx.trackOperationBody(new Promise<void>((r) => (release = r)))
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: null })
    ctx.finalizeModelOperationDelivery()

    // Settled → out of the visible registry, but operation still in flight.
    expect(manager.activeCount).toBe(0)

    const tracker: ShutdownDrainSource = { getActive: () => manager.getTrackedOperations() }
    const drainPromise = drainActiveRequests(2000, tracker, { pollIntervalMs: 10 })

    // Give the drain time to poll a few times — it must still see the un-quiesced operation.
    await new Promise((r) => setTimeout(r, 60))
    expect(manager.trackedOperationCount).toBe(1)

    // Now let the operation quiesce → drain must complete "drained" (not "timeout").
    release()
    const result = await drainPromise
    expect(result).toBe("drained")
    expect(manager.trackedOperationCount).toBe(0)
  })

  test("drain completes promptly for an unwired settled ctx (behavior-preserving)", async () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: null })
    ctx.finalizeModelOperationDelivery()

    const tracker: ShutdownDrainSource = { getActive: () => manager.getTrackedOperations() }
    const result = await drainActiveRequests(2000, tracker, { pollIntervalMs: 10 })
    expect(result).toBe("drained")
  })

  test("drain waits after operation quiescence until delivery starts the generation finalizer", async () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: null })

    const tracker: ShutdownDrainSource = { getActive: () => manager.getTrackedOperations() }
    const drainPromise = drainActiveRequests(2000, tracker, { pollIntervalMs: 10 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(manager.trackedOperationCount).toBe(1)

    ctx.finalizeModelOperationDelivery()
    await ctx.whenModelOperationFinalized()
    await expect(drainPromise).resolves.toBe("drained")
  })
})
