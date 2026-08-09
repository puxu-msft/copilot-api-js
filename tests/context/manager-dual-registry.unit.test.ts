import {
  //
  describe,
  test,
  expect,
} from "bun:test"

import { createRequestContextManager } from "~/lib/context/manager"

// Dual registry: `visibleContexts` (getAll/activeCount/get) is deleted at logical settle so UI/status
// semantics remain unchanged. `operationScopes` (getTrackedOperations/trackedOperationCount) serves
// shutdown and retains the ctx through operation quiescence plus generation observability finalization.
// Manager auto-seals the operation scope on settle; delivery and canonical publish may complete later.

function completeCtx(ctx: ReturnType<ReturnType<typeof createRequestContextManager>["create"]>) {
  ctx.complete({ success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: null })
}

describe("manager dual registry (C5 Task 5)", () => {
  test("visibleContexts (getAll/activeCount) deleted on settle — UNCHANGED", () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    expect(manager.activeCount).toBe(1)
    expect(manager.getAll()).toHaveLength(1)
    completeCtx(ctx)
    ctx.finalizeModelOperationDelivery()
    expect(manager.activeCount).toBe(0)
    expect(manager.getAll()).toHaveLength(0)
  })

  test("ctx with no operation child leaves the registry only after its generation finalizer", async () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    expect(manager.trackedOperationCount).toBe(1)
    completeCtx(ctx)
    ctx.finalizeModelOperationDelivery()
    // The manager retains the context through the explicit generation-finalizer join.
    await ctx.whenModelOperationFinalized()
    await Promise.resolve()
    expect(manager.trackedOperationCount).toBe(0)
  })

  test("ctx with pending tracked operation stays in operationScopes past settle until quiesce", async () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    let release!: () => void
    ctx.trackOperationBody(new Promise<void>((r) => (release = r)))

    completeCtx(ctx)
    ctx.finalizeModelOperationDelivery()
    // visibleContexts gone immediately…
    expect(manager.activeCount).toBe(0)
    await Promise.resolve()
    await Promise.resolve()
    // …but operationScopes RETAINED — settle-before work still in flight (the orphan we must drain).
    expect(manager.trackedOperationCount).toBe(1)
    expect(manager.getTrackedOperations()).toHaveLength(1)

    release()
    // Wait for the operation to quiesce (poll a couple microtasks + a macrotask).
    await new Promise((r) => setTimeout(r, 5))
    expect(manager.trackedOperationCount).toBe(0)
  })

  test("retains a quiesced operation until delivery starts and the generation finalizer settles", async () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })

    completeCtx(ctx)
    await Promise.resolve()
    await Promise.resolve()
    expect(manager.trackedOperationCount).toBe(1)
    expect(ctx.modelOperationTerminalRecord).toBeNull()

    ctx.finalizeModelOperationDelivery()
    await ctx.whenModelOperationFinalized()
    await Promise.resolve()
    expect(manager.trackedOperationCount).toBe(0)
  })

  test("surfaces generation-finalizer rejection through the manager durability drain", async () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    ctx.beginGenerationCandidate({ role: "recovery" })

    completeCtx(ctx)
    ctx.finalizeModelOperationDelivery()
    await expect(ctx.whenModelOperationFinalized()).rejects.toThrow(/open candidate/i)
    // The canonical failure is registered by the manager's own barrier (onLifecycleFailure) inside
    // RequestContext's finalizer catch BEFORE it rejects — so by the time the reject callback here
    // runs, `releaseTrackedOperationIfTerminal` both releases the ctx AND evicts the barrier entry
    // into `modelOperationFinalizationFailures`. Assert exactly ONE error surfaces (not two) — the
    // reject callback itself must NOT also push the same error, or this would double-count.
    let caught: unknown
    try {
      await manager.drainLifecycleFailures()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toHaveLength(1)
    expect(manager.trackedOperationCount).toBe(0)
  })

  // Review blocker (commit 3e418cdb): a delivery failure ALONE (canonical still succeeds) never
  // rejects `whenModelOperationFinalized()` — the finalizer resolves normally because a registered
  // delivery failure is recorded in terminal metadata, not thrown. The old reject-branch-only push
  // into `modelOperationFinalizationFailures` therefore never saw this case: the error sat forever
  // in the write-only `lifecycleFailureBarrier` map while the ctx was already gone from the
  // registry. This is the exact scenario the fix (evicting the barrier inside
  // `releaseTrackedOperationIfTerminal`, on BOTH the resolve and reject branches) must cover.
  test("a registered delivery failure alone (canonical succeeds) surfaces through drainLifecycleFailures with the original error", async () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    const error = new Error("delivery write failed")

    completeCtx(ctx)
    ctx.beginModelOperationDeliveryFinalization()
    ctx.failModelOperationDelivery(error)
    // The finalizer RESOLVES (not rejects) — a registered delivery failure is folded into terminal
    // metadata while canonical still completes successfully.
    const record = await ctx.whenModelOperationFinalized()
    expect(record.terminal?.outcome).toBe("completed")
    await Promise.resolve()
    expect(manager.trackedOperationCount).toBe(0)

    let caught: unknown
    try {
      await manager.drainLifecycleFailures()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([error])
  })

  // Review MAJOR (commit 3e418cdb): `lifecycleFailureBarrier` must NOT grow monotonically for the
  // life of the process. Its storage lifetime must be bounded by tracked-operation lifetime
  // (evicted the moment `releaseTrackedOperationIfTerminal` deletes the id from `operationScopes`),
  // NOT by whether/how often anyone calls `drainLifecycleFailures()` — in production that only
  // happens at shutdown, and this manager is a process-level singleton.
  test("lifecycleFailureBarrier does not grow across many failed-then-released requests without ever draining", async () => {
    const manager = createRequestContextManager()
    const requestCount = 25

    for (let i = 0; i < requestCount; i++) {
      const ctx = manager.create({ endpoint: "anthropic-messages" })
      completeCtx(ctx)
      ctx.beginModelOperationDeliveryFinalization()
      ctx.failModelOperationDelivery(new Error(`delivery write failed #${i}`))
      await ctx.whenModelOperationFinalized()
    }
    await Promise.resolve()

    // All 25 requests are already released (blocker "none" for each) — the barrier must have been
    // evicted at release time for every one of them, not accumulated. NEVER drained in this test.
    expect(manager.trackedOperationCount).toBe(0)
    expect(manager._lifecycleFailureBarrierSize()).toBe(0)
  })

  // Multi-request isolation: releasing one terminal tracked operation must never touch another
  // request's still-in-flight entry (or its barrier state).
  test("releasing one terminal tracked operation deletes only its own id, leaving another request's pending entry untouched", async () => {
    const manager = createRequestContextManager()
    const done = manager.create({ endpoint: "anthropic-messages" })
    const pending = manager.create({ endpoint: "anthropic-messages" })
    let release!: () => void
    pending.trackOperationBody(new Promise<void>((r) => (release = r)))

    completeCtx(done)
    done.finalizeModelOperationDelivery()
    await done.whenModelOperationFinalized()

    completeCtx(pending)
    await Promise.resolve()
    await Promise.resolve()

    expect(manager.trackedOperationCount).toBe(1)
    expect(manager.getTrackedOperations()).toEqual([pending])

    release()
    await new Promise((r) => setTimeout(r, 5))
    pending.finalizeModelOperationDelivery()
    await pending.whenModelOperationFinalized()
    await Promise.resolve()
    expect(manager.trackedOperationCount).toBe(0)
  })

  // canonical-finalization blocker: `finalizeModelOperationDelivery()` synchronously calls
  // `startGenerationFinalizerIfReady()`, which sets `canonicalState = "running"` BEFORE the async
  // finalizer body's first `await` — so there is a real (not contrived) synchronous window, right
  // after the call returns, where `blocker === "canonical-finalization"` even though delivery is
  // already terminal and the operation scope was already quiesced (no children tracked).
  test("getTrackedOperationsSnapshot reports canonical-finalization blocker in the synchronous window before the finalizer commits", () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    completeCtx(ctx)
    ctx.finalizeModelOperationDelivery()

    expect(ctx.operationLifecycle.blocker).toBe("canonical-finalization")
    expect(manager.getTrackedOperationsSnapshot()).toMatchObject({
      count: 1,
      byBlocker: { "request-running": 0, "operation-body": 0, "delivery-finalization": 0, "canonical-finalization": 1 },
    })
  })

  test("getTrackedOperationsSnapshot aggregates immediately by blocker with exact shape", async () => {
    const manager = createRequestContextManager()

    // ctx1: settled, but a tracked operation-body child is still pending — blocker "operation-body".
    const ctx1 = manager.create({ endpoint: "anthropic-messages" })
    let release!: () => void
    ctx1.trackOperationBody(new Promise<void>((r) => (release = r)))
    completeCtx(ctx1)

    // ctx2: settled with no operation-body child (quiesces instantly), but delivery never started —
    // blocker "delivery-finalization".
    const ctx2 = manager.create({ endpoint: "anthropic-messages" })
    completeCtx(ctx2)
    await Promise.resolve()
    await Promise.resolve()

    const now = ctx1.startTime + 1000
    expect(manager.getTrackedOperationsSnapshot(now)).toEqual({
      count: 2,
      byBlocker: { "request-running": 0, "operation-body": 1, "delivery-finalization": 1, "canonical-finalization": 0 },
      oldestAgeMs: now - ctx1.startTime,
    })

    // Zero-count shape: oldestAgeMs is 0, byBlocker sums to 0.
    release()
    await new Promise((r) => setTimeout(r, 5))
    ctx1.finalizeModelOperationDelivery()
    await ctx1.whenModelOperationFinalized()
    ctx2.finalizeModelOperationDelivery()
    await ctx2.whenModelOperationFinalized()
    await Promise.resolve()
    expect(manager.getTrackedOperationsSnapshot(now)).toEqual({
      count: 0,
      byBlocker: { "request-running": 0, "operation-body": 0, "delivery-finalization": 0, "canonical-finalization": 0 },
      oldestAgeMs: 0,
    })
  })
})
