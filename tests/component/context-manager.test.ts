/**
 * Component tests for RequestContextManager event system.
 *
 * Tests: createRequestContextManager, event forwarding, lifecycle management
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { RequestContextEvent } from "~/lib/context/manager"

import { createRequestContextManager } from "~/lib/context/manager"
import { state, setStateForTests } from "~/lib/state"

import { waitUntil } from "../helpers/wait-until"

describe("createRequestContextManager", () => {
  test("create() returns RequestContext and tracks it", () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages", tuiLogId: "t1" })

    expect(ctx.id).toMatch(/^req_/)
    expect(ctx.endpoint).toBe("anthropic-messages")
    expect(manager.activeCount).toBe(1)
  })

  test("get() returns active context by id", () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "openai-chat-completions" })

    expect(manager.get(ctx.id)).toBe(ctx)
  })

  test("get() returns undefined for unknown id", () => {
    const manager = createRequestContextManager()
    expect(manager.get("nonexistent")).toBeUndefined()
  })

  test("getAll() returns all active contexts", () => {
    const manager = createRequestContextManager()
    const ctx1 = manager.create({ endpoint: "anthropic-messages" })
    const ctx2 = manager.create({ endpoint: "openai-chat-completions" })

    const all = manager.getAll()
    expect(all).toHaveLength(2)
    expect(all).toContain(ctx1)
    expect(all).toContain(ctx2)
  })

  test("emits created event on create()", () => {
    const manager = createRequestContextManager()
    const listener = mock<(event: RequestContextEvent) => void>(() => {})
    manager.on("change", listener)

    const ctx = manager.create({ endpoint: "anthropic-messages" })

    expect(listener).toHaveBeenCalled()
    const event = listener.mock.calls[0][0]
    expect(event.type).toBe("created")
    expect(event.context).toBe(ctx)
  })

  test("forwards state_changed events from context", () => {
    const manager = createRequestContextManager()
    const events: Array<RequestContextEvent> = []
    manager.on("change", (e) => events.push(e))

    const ctx = manager.create({ endpoint: "anthropic-messages" })
    ctx.transition("executing")

    const stateEvents = events.filter((e) => e.type === "state_changed")
    expect(stateEvents).toHaveLength(1)
    expect(stateEvents[0].type === "state_changed" && stateEvents[0].previousState).toBe("pending")
  })

  test("removes context from active on complete", () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })
    ctx.beginAttempt({})

    expect(manager.activeCount).toBe(1)

    ctx.complete({
      success: true,
      model: "m",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: "ok",
    })

    expect(manager.activeCount).toBe(0)
    expect(manager.get(ctx.id)).toBeUndefined()
  })

  test("removes context from active on fail", () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "openai-chat-completions" })
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })
    ctx.beginAttempt({})

    ctx.fail("m", new Error("test failure"))

    expect(manager.activeCount).toBe(0)
    expect(manager.get(ctx.id)).toBeUndefined()
  })

  test("on/off subscribes and unsubscribes", () => {
    const manager = createRequestContextManager()
    const listener = mock<(event: RequestContextEvent) => void>(() => {})

    manager.on("change", listener)
    manager.create({ endpoint: "anthropic-messages" }) // triggers "created"
    expect(listener).toHaveBeenCalledTimes(1)

    manager.off("change", listener)
    manager.create({ endpoint: "openai-chat-completions" }) // should NOT trigger
    expect(listener).toHaveBeenCalledTimes(1) // still 1
  })

  test("multiple listeners all receive events", () => {
    const manager = createRequestContextManager()
    const listener1 = mock<(event: RequestContextEvent) => void>(() => {})
    const listener2 = mock<(event: RequestContextEvent) => void>(() => {})

    manager.on("change", listener1)
    manager.on("change", listener2)
    manager.create({ endpoint: "anthropic-messages" })

    expect(listener1).toHaveBeenCalledTimes(1)
    expect(listener2).toHaveBeenCalledTimes(1)
  })

  test("swallows listener errors without crashing", () => {
    const manager = createRequestContextManager()
    const badListener = mock(() => {
      throw new Error("listener crash")
    })
    const goodListener = mock<(event: RequestContextEvent) => void>(() => {})

    manager.on("change", badListener)
    manager.on("change", goodListener)

    // Should not throw
    manager.create({ endpoint: "anthropic-messages" })

    // Both should have been called
    expect(badListener).toHaveBeenCalledTimes(1)
    expect(goodListener).toHaveBeenCalledTimes(1)
  })
})

// ─── Stale Request Reaper ───

describe("stale request reaper", () => {
  let origMaxAge: number

  beforeEach(() => {
    origMaxAge = state.staleRequestMaxAge
  })

  afterEach(() => {
    setStateForTests({ staleRequestMaxAge: origMaxAge })
  })

  test("startReaper is idempotent (multiple calls don't crash)", () => {
    const manager = createRequestContextManager()
    manager.startReaper()
    manager.startReaper() // second call — should be no-op
    manager.stopReaper()
  })

  test("stopReaper is safe when reaper was never started", () => {
    const manager = createRequestContextManager()
    manager.stopReaper() // should not throw
  })

  test("_runReaperOnce force-fails contexts exceeding maxAge", async () => {
    setStateForTests({ staleRequestMaxAge: 0.05 })

    const manager = createRequestContextManager()
    const events: Array<RequestContextEvent> = []
    manager.on("change", (e) => events.push(e))

    const ctx = manager.create({ endpoint: "anthropic-messages" })
    ctx.setOriginalRequest({ model: "test-model", messages: [], stream: true, payload: {} })
    ctx.beginAttempt({})

    expect(manager.activeCount).toBe(1)
    expect(ctx.settled).toBe(false)

    await waitUntil(() => ctx.durationMs > 50, {
      label: "context to exceed stale request max age",
    })

    manager._runReaperOnce()

    expect(manager.activeCount).toBe(0)
    expect(ctx.settled).toBe(true)
    const failEvents = events.filter((e) => e.type === "failed")
    expect(failEvents).toHaveLength(1)
  })

  test("_runReaperOnce does not fail contexts within maxAge", () => {
    setStateForTests({ staleRequestMaxAge: 600 })

    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })
    ctx.beginAttempt({})

    manager._runReaperOnce()

    expect(manager.activeCount).toBe(1) // should not be reaped
  })

  test("_runReaperOnce skips when staleRequestMaxAge is 0 (disabled)", () => {
    setStateForTests({ staleRequestMaxAge: 0 })

    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })
    ctx.beginAttempt({})

    manager._runReaperOnce()

    expect(manager.activeCount).toBe(1) // should not be reaped
  })

  test("_runReaperOnce handles already-completed context gracefully", async () => {
    setStateForTests({ staleRequestMaxAge: 0.01 })

    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })
    ctx.beginAttempt({})

    // Complete normally — removes from activeContexts
    ctx.complete({
      success: true,
      model: "m",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: "ok",
    })

    // Reaper should not find it in activeContexts
    manager._runReaperOnce()
    expect(manager.activeCount).toBe(0)
  })
})

// ─── Dangling Context Prevention ───

describe("dangling context prevention", () => {
  test("context created but never settled remains in activeContexts (demonstrates the problem)", () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })

    // Context exists but was never completed or failed — this is the dangling state
    // The fix (moving validation before create) prevents this scenario entirely
    expect(manager.activeCount).toBe(1)
    expect(manager.get(ctx.id)).toBeDefined()
    expect(ctx.settled).toBe(false)
  })

  test("context that is properly failed is removed from activeContexts", () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })
    ctx.beginAttempt({})
    ctx.fail("m", new Error("unsupported model"))

    expect(manager.activeCount).toBe(0)
    expect(manager.get(ctx.id)).toBeUndefined()
    expect(ctx.settled).toBe(true)
  })
})
