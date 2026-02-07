/**
 * Component tests for RequestContextManager event system.
 *
 * Tests: createRequestContextManager, event forwarding, lifecycle management
 */

import { describe, expect, mock, test } from "bun:test"

import type { RequestContextEvent } from "~/lib/context/manager"

import { createRequestContextManager } from "~/lib/context/manager"

describe("createRequestContextManager", () => {
  test("create() returns RequestContext and tracks it", () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic", trackingId: "t1" })

    expect(ctx.id).toMatch(/^req_/)
    expect(ctx.endpoint).toBe("anthropic")
    expect(manager.activeCount).toBe(1)
  })

  test("get() returns active context by id", () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "openai" })

    expect(manager.get(ctx.id)).toBe(ctx)
  })

  test("get() returns undefined for unknown id", () => {
    const manager = createRequestContextManager()
    expect(manager.get("nonexistent")).toBeUndefined()
  })

  test("getAll() returns all active contexts", () => {
    const manager = createRequestContextManager()
    const ctx1 = manager.create({ endpoint: "anthropic" })
    const ctx2 = manager.create({ endpoint: "openai" })

    const all = manager.getAll()
    expect(all).toHaveLength(2)
    expect(all).toContain(ctx1)
    expect(all).toContain(ctx2)
  })

  test("emits created event on create()", () => {
    const manager = createRequestContextManager()
    const listener = mock<(event: RequestContextEvent) => void>(() => {})
    manager.on("change", listener)

    const ctx = manager.create({ endpoint: "anthropic" })

    expect(listener).toHaveBeenCalled()
    const event = listener.mock.calls[0][0]
    expect(event.type).toBe("created")
    expect(event.context).toBe(ctx)
  })

  test("forwards state_changed events from context", () => {
    const manager = createRequestContextManager()
    const events: Array<RequestContextEvent> = []
    manager.on("change", (e) => events.push(e))

    const ctx = manager.create({ endpoint: "anthropic" })
    ctx.transition("executing")

    const stateEvents = events.filter((e) => e.type === "state_changed")
    expect(stateEvents).toHaveLength(1)
    expect(stateEvents[0].type === "state_changed" && stateEvents[0].previousState).toBe("pending")
  })

  test("removes context from active on complete", () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic" })
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
    const ctx = manager.create({ endpoint: "openai" })
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
    manager.create({ endpoint: "anthropic" }) // triggers "created"
    expect(listener).toHaveBeenCalledTimes(1)

    manager.off("change", listener)
    manager.create({ endpoint: "openai" }) // should NOT trigger
    expect(listener).toHaveBeenCalledTimes(1) // still 1
  })

  test("multiple listeners all receive events", () => {
    const manager = createRequestContextManager()
    const listener1 = mock<(event: RequestContextEvent) => void>(() => {})
    const listener2 = mock<(event: RequestContextEvent) => void>(() => {})

    manager.on("change", listener1)
    manager.on("change", listener2)
    manager.create({ endpoint: "anthropic" })

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
    manager.create({ endpoint: "anthropic" })

    // Both should have been called
    expect(badListener).toHaveBeenCalledTimes(1)
    expect(goodListener).toHaveBeenCalledTimes(1)
  })
})
