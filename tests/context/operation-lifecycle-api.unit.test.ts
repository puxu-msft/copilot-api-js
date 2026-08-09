import {
  //
  describe,
  test,
  expect,
} from "bun:test"

import { createRequestContext } from "~/lib/context/request"

// C0-lifecycle Task 4: RequestContext operation-lifecycle API (RFC §3.3). NEW API — behavior-
// preserving (no production callers yet). Verifies cancel is idempotent + decoupled from settle,
// operationSignal reflects cancel, and operation-scope delegation works.

function makeCtx() {
  return createRequestContext({ endpoint: "anthropic-messages" })
}

describe("RequestContext operation lifecycle (C5 Task 4)", () => {
  test("cancel() aborts operationSignal + records reason, without settling", () => {
    const ctx = makeCtx()
    expect(ctx.cancelled).toBe(false)
    expect(ctx.operationSignal.aborted).toBe(false)
    expect(ctx.settled).toBe(false)

    ctx.cancel("deadline")

    expect(ctx.cancelled).toBe(true)
    expect(ctx.cancelReason).toBe("deadline")
    expect(ctx.operationSignal.aborted).toBe(true)
    // Decoupled: cancel does NOT settle.
    expect(ctx.settled).toBe(false)
  })

  test("cancel() is idempotent — first reason wins", () => {
    const ctx = makeCtx()
    ctx.cancel("deadline")
    ctx.cancel("shutdown")
    expect(ctx.cancelReason).toBe("deadline")
  })

  test("reapInFlight() also aborts operationSignal (shared cancel wiring)", () => {
    const ctx = makeCtx()
    ctx.reapInFlight()
    expect(ctx.operationSignal.aborted).toBe(true)
  })

  test("whenOperationQuiesced resolves after seal + tracked children settle", async () => {
    const ctx = makeCtx()
    let release!: () => void
    ctx.trackOperationBody(new Promise<void>((r) => (release = r)))
    let quiesced = false
    void ctx.whenOperationQuiesced().then(() => (quiesced = true))

    ctx.sealOperationScope()
    await Promise.resolve()
    expect(quiesced).toBe(false) // sealed but child pending

    release()
    await ctx.whenOperationQuiesced()
    expect(quiesced).toBe(true)
  })
})
