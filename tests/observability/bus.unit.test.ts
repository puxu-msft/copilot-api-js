/**
 * Unit tests for the observability bus.
 *
 * Covers:
 * - `subscribe` registration + `unsubscribe` return value
 * - filter predicate is applied at fan-out time
 * - handler error isolation (one bad handler does not stop fan-out)
 * - async handlers tracked by `flush()`
 * - `publish` is synchronous (does not wait for async handlers)
 * - `publishAndFlush` awaits async handlers
 * - `publishAndFlush` respects the `deadlineMs` budget
 * - `scope` returns a publisher whose typed `publish` works at runtime
 *   (TypeScript Extract enforcement is covered by the compile step)
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ObservabilityEvent,
  RequestContextSnapshot,
} from "~/lib/observability"

import { createBus } from "~/lib/observability"

function makeCtx(): RequestContextSnapshot {
  return {
    id: "ctx-1",
    endpoint: "anthropic-messages",
    method: "POST",
    path: "/v1/messages",
    state: "executing",
    startTime: Date.now(),
    queueWaitMs: 0,
  }
}

describe("createBus", () => {
  test("a throwing filter is isolated and later subscribers still receive the event", () => {
    const failures: Array<string> = []
    const bus = createBus({ onSubscriberError: ({ subscriber, phase }) => failures.push(`${subscriber}:${phase}`) })
    const received: Array<string> = []
    bus.subscribe(
      () => {},
      () => {
        throw new Error("filter boom")
      },
      { name: "bad-filter" },
    )
    bus.subscribe((event) => void received.push(event.kind), undefined, { name: "healthy" })

    expect(() => bus.scope("request").publish({ kind: "request.created", ctx: makeCtx() })).not.toThrow()
    expect(received).toEqual(["request.created"])
    expect(failures).toEqual(["bad-filter:filter"])
  })

  test("a rejecting thenable is tracked and reported without blocking later subscribers", async () => {
    const failures: Array<string> = []
    const bus = createBus({ onSubscriberError: ({ subscriber, phase }) => failures.push(`${subscriber}:${phase}`) })
    const received: Array<string> = []
    const rejectingThenable = Promise.resolve().then(() => {
      throw new Error("thenable boom")
    })
    bus.subscribe(() => rejectingThenable, undefined, { name: "thenable" })
    bus.subscribe((event) => void received.push(event.kind), undefined, { name: "healthy" })

    bus.scope("request").publish({ kind: "request.created", ctx: makeCtx() })
    await bus.flush()
    expect(received).toEqual(["request.created"])
    expect(failures).toEqual(["thenable:async-handler"])
  })

  test("subscribe → publish → handler receives event", () => {
    const bus = createBus()
    const received: Array<ObservabilityEvent> = []
    bus.subscribe((e) => {
      received.push(e)
    })

    const requestPub = bus.scope("request")
    requestPub.publish({ kind: "request.created", ctx: makeCtx() })

    expect(received).toHaveLength(1)
    expect(received[0].kind).toBe("request.created")
  })

  test("unsubscribe stops future deliveries", () => {
    const bus = createBus()
    const received: Array<ObservabilityEvent> = []
    const unsub = bus.subscribe((e) => {
      received.push(e)
    })
    const requestPub = bus.scope("request")

    requestPub.publish({ kind: "request.created", ctx: makeCtx() })
    unsub()
    requestPub.publish({ kind: "request.model_resolved", ctx: makeCtx() })

    expect(received).toHaveLength(1)
    expect(received[0].kind).toBe("request.created")
  })

  test("filter predicate restricts delivery", () => {
    const bus = createBus()
    const received: Array<ObservabilityEvent> = []
    bus.subscribe(
      (e) => {
        received.push(e)
      },
      (e) => e.kind === "request.completed",
    )

    const requestPub = bus.scope("request")
    requestPub.publish({ kind: "request.created", ctx: makeCtx() }) // filtered out
    requestPub.publish({ kind: "request.model_resolved", ctx: makeCtx() }) // filtered out

    expect(received).toHaveLength(0)
  })

  test("one handler throwing does not stop fan-out to others", () => {
    const bus = createBus()
    const received: Array<string> = []
    bus.subscribe(() => {
      throw new Error("first handler bad")
    })
    bus.subscribe((e) => {
      received.push(`b:${e.kind}`)
    })
    bus.subscribe((e) => {
      received.push(`c:${e.kind}`)
    })

    const requestPub = bus.scope("request")
    // Should not throw; bad handler is isolated.
    requestPub.publish({ kind: "request.created", ctx: makeCtx() })

    expect(received).toEqual(["b:request.created", "c:request.created"])
  })

  test("publish does NOT await async handlers", async () => {
    const bus = createBus()
    let resolved = false
    bus.subscribe(async () => {
      await new Promise((r) => setTimeout(r, 50))
      resolved = true
    })

    const requestPub = bus.scope("request")
    requestPub.publish({ kind: "request.created", ctx: makeCtx() })

    // publish returned synchronously; async handler has not completed yet.
    expect(resolved).toBe(false)
    await bus.flush()
    expect(resolved).toBe(true)
  })

  test("publishAndFlush awaits all async handlers", async () => {
    const bus = createBus()
    let done = 0
    bus.subscribe(async () => {
      await new Promise((r) => setTimeout(r, 20))
      done++
    })
    bus.subscribe(async () => {
      await new Promise((r) => setTimeout(r, 40))
      done++
    })

    const systemPub = bus.scope("system")
    const result = await systemPub.publishAndFlush({ kind: "system.shutdown_completed" })

    expect(done).toBe(2)
    expect(result.pendingWsBuffer).toBe(0)
  })

  test("publishAndFlush respects deadlineMs", async () => {
    const bus = createBus()
    const DEADLINE_MS = 50
    let done = 0
    // The handler waits on a gate we never open before asserting, rather than on a timer. The
    // original slept 500ms "intentionally past the deadline"; a gate is the limiting case of that
    // same intent, and it takes the fixture out of the race: `done === 0` below no longer means
    // "we beat a 500ms timer", it means the handler genuinely cannot have finished.
    let releaseHandler!: () => void
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve
    })
    bus.subscribe(async () => {
      await handlerGate
      done++
    })

    const systemPub = bus.scope("system")
    const start = Date.now()
    const result = await systemPub.publishAndFlush({ kind: "system.shutdown_completed" }, { deadlineMs: DEADLINE_MS })
    const elapsed = Date.now() - start

    // The causal oracle, and it reads no clock: the deadline leg is what returned us here, and it
    // used the value we asked for — the message embeds `deadlineMs`. This is what the old
    // `elapsed < 200` was inferring indirectly, and unlike that bound it also catches a deadline
    // that is ignored entirely (returning at once would record no failure at all).
    expect(result.failures).toHaveLength(1)
    expect(result.failures?.[0]).toMatchObject({
      subscriber: "publishAndFlush",
      phase: "async-handler",
      eventKind: "system.shutdown_completed",
    })
    // `SubscriberFailure.error` is `unknown` by design, so narrow before reading the message.
    const deadlineFailure = result.failures?.[0].error
    expect(deadlineFailure).toBeInstanceOf(Error)
    expect((deadlineFailure as Error).message).toBe(`Observability flush deadline exceeded after ${DEADLINE_MS}ms`)
    expect(done).toBe(0) // handler still in-flight
    // Bound on the deadline's DURATION, deliberately kept at the old 4x (200ms). This one is NOT a
    // loose outlier backstop like the streaming cases': the causal assertions above prove the
    // deadline leg fired and that it reported the value we asked for, but the reported value is the
    // REQUESTED one — an implementation whose timer runs for a different duration than it reports
    // still satisfies them. Measured: with the timer set to 6x the request, a 2000ms ceiling passes
    // while this one reddens, so widening it would trade away real coverage. Widening is therefore a
    // guard-weakening decision, recorded for adjudication rather than taken here; see the
    // dispositions doc. An implementation that ignores the deadline and waits for the handler shows
    // up as a per-test timeout instead, since the gate stays shut.
    expect(elapsed).toBeLessThan(DEADLINE_MS * 4)

    releaseHandler()
    await bus.flush() // clean up
  })

  test("flush resolves immediately when no async handlers are in flight", async () => {
    const bus = createBus()
    bus.subscribe(() => {
      /* sync */
    })
    const requestPub = bus.scope("request")
    requestPub.publish({ kind: "request.created", ctx: makeCtx() })
    await expect(bus.flush()).resolves.toBeUndefined()
  })

  test("scoped publisher only mints a publisher; runtime accepts any event of the namespace", () => {
    // Type-level enforcement (Extract<...>) is checked at compile time;
    // here we only verify the publisher exists and forwards correctly.
    const bus = createBus()
    const received: Array<ObservabilityEvent> = []
    bus.subscribe((e) => {
      received.push(e)
    })

    const historyPub = bus.scope("history")
    historyPub.publish({ kind: "history.cleared" })
    historyPub.publish({ kind: "history.session_deleted", sessionId: "s1" })

    expect(received.map((e) => e.kind)).toEqual(["history.cleared", "history.session_deleted"])
  })
})
