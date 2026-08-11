/**
 * Component tests for RequestContextManager event system.
 *
 * Tests: createRequestContextManager, event forwarding, lifecycle management
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ObservabilityEvent } from "~/lib/observability"

import { createRequestContextManager } from "~/lib/context/manager"
import { createBus } from "~/lib/observability"
/**
 * Build a manager wired to a fresh per-test bus + recording subscriber, so
 * tests can assert on the `request.*` bus stream (the single event channel
 * since P0.3 — the manager no longer exposes its own `on("change")` listeners).
 */
function makeManager() {
  const bus = createBus()
  const events: Array<ObservabilityEvent> = []
  bus.subscribe((e) => {
    events.push(e)
  })
  const manager = createRequestContextManager({ publisher: bus.scope("request") })
  return { manager, events }
}

describe("createRequestContextManager", () => {
  test("create() returns RequestContext and tracks it", () => {
    const manager = createRequestContextManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })

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

  test("publishes request.created on create()", () => {
    const { manager, events } = makeManager()

    const ctx = manager.create({ endpoint: "anthropic-messages" })

    const created = events.filter((e) => e.kind === "request.created")
    expect(created).toHaveLength(1)
    expect(created[0].kind === "request.created" && created[0].ctx.id).toBe(ctx.id)
  })

  test("publishes state_changed events from context", () => {
    const { manager, events } = makeManager()

    manager.create({ endpoint: "anthropic-messages" })
    const before = events.length

    const ctx = manager.create({ endpoint: "anthropic-messages" })
    ctx.transition("executing")

    const stateEvents = events.slice(before).filter((e) => e.kind === "request.state_changed")
    expect(stateEvents).toHaveLength(1)
    expect(stateEvents[0].kind === "request.state_changed" && stateEvents[0].previousState).toBe("pending")
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
})

// ─── Request-level cancel primitive ───

// The periodic stale reaper was removed on 2026-08-11 (its kill was a coarser duplicate of
// `timeouts.client_request_deadline`), and its scan tests went with it. `reapInFlight()` did NOT:
// it is still the request-level cancel primitive, now driven by shutdown's operator-abandoned
// drain, so its idempotence and its effect on the lifecycle signal stay guarded here.
describe("reapInFlight", () => {
  test("reapInFlight() aborts the lifecycle signal (idempotent, independent of fail)", () => {
    const { manager } = makeManager()
    const ctx = manager.create({ endpoint: "anthropic-messages" })
    expect(ctx.lifecycleSignal.aborted).toBe(false)
    ctx.reapInFlight()
    expect(ctx.lifecycleSignal.aborted).toBe(true)
    ctx.reapInFlight() // idempotent — second call is a no-op
    expect(ctx.lifecycleSignal.aborted).toBe(true)
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
