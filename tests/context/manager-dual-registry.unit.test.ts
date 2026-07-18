import { describe, test, expect } from "bun:test"

import { createRequestContextManager } from "~/lib/context/manager"

// C5 Task 5: dual registry. `visibleContexts` (getAll/activeCount/get) is UNCHANGED — deleted on
// settle (UI/status semantics preserved). `operationScopes` (getTrackedOperations/
// trackedOperationCount) serves the shutdown drain: a ctx stays tracked until its operation body
// QUIESCES, not merely until settle — so orphan settle-before work is drained. Manager auto-seals
// the scope on settle (settle ⇒ no new operations start). For an UNWIRED ctx (no trackOperationBody)
// childCount=0 ⇒ quiesces immediately ⇒ leaves operationScopes at settle = behavior-preserving.

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
    expect(manager.activeCount).toBe(0)
    expect(manager.getAll()).toHaveLength(0)
  })

  test("unwired ctx (no tracked operation) leaves operationScopes at settle — behavior-preserving", async () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    expect(manager.trackedOperationCount).toBe(1)
    completeCtx(ctx)
    // seal-on-settle → childCount 0 → quiesces on a microtask.
    await Promise.resolve()
    await Promise.resolve()
    expect(manager.trackedOperationCount).toBe(0)
  })

  test("ctx with pending tracked operation stays in operationScopes past settle until quiesce", async () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    let release!: () => void
    ctx.trackOperationBody(new Promise<void>((r) => (release = r)))

    completeCtx(ctx)
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
})
