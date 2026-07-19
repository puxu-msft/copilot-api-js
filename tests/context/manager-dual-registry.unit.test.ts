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
    await expect(manager.drainModelOperationFinalizations()).rejects.toThrow("Generation finalization failed")
    expect(manager.trackedOperationCount).toBe(0)
  })
})
