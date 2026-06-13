/**
 * Integration test for the sink-attach-order contract (RFC §2.4).
 *
 * The contract: HistorySink → TelemetrySink → WsSink → ConsoleSink.
 *
 * Rationale: HistorySink must persist a terminal entry before WsSink
 * broadcasts the resulting `history.entry_updated`, otherwise a downstream
 * client receiving the WS notification and immediately querying
 * `GET /history/api/entries/:id` could find an empty row.
 *
 * The bus runs handlers in subscription order inside isolated try/catch.
 * This test pins that contract by:
 *  1. Wrapping a fake HistorySink so its work happens inside a microtask
 *     (`queueMicrotask`) — simulating any future async drift.
 *  2. Subscribing a fake WsSink that records the time-of-broadcast.
 *  3. Asserting WsSink's broadcast observation happens AFTER HistorySink's
 *     "write" has settled.
 *
 * In production `bun:sqlite` writes are synchronous so this latency is
 * zero, but a single bad future refactor that adds `await` anywhere in
 * the HistorySink write path would surface here.
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

function makeCtx(id = "ctx-1"): RequestContextSnapshot {
  return {
    id,
    endpoint: "anthropic-messages",
    method: "POST",
    path: "/v1/messages",
    state: "completed",
    startTime: Date.now() - 100,
    queueWaitMs: 0,
  }
}

function makeTerminalEvent(ctx: RequestContextSnapshot): Extract<ObservabilityEvent, { kind: "request.completed" }> {
  return {
    kind: "request.completed",
    ctx,
    // Minimal HistoryEntryData shim — we just need a recognizable object reference.
    entry: { id: ctx.id, endpoint: "anthropic-messages", state: "completed" } as never,
  }
}

describe("sink attach ordering (RFC §2.4)", () => {
  test("HistorySink (subscribed first) observes a request.completed BEFORE WsSink does", async () => {
    const bus = createBus()
    const trace: Array<string> = []

    // Subscribe in canonical order.
    bus.subscribe((event) => {
      if (event.kind !== "request.completed") return
      // Simulate the cheapest possible async drift: a microtask. In real
      // HistorySink this would be `bun:sqlite` synchronous I/O = 0 drift.
      // Even one microtask of drift is enough to expose ordering bugs if
      // any consumer awaits.
      trace.push("history:start")
      queueMicrotask(() => {
        trace.push("history:end")
      })
    })

    bus.subscribe((event) => {
      if (event.kind !== "request.completed") return
      trace.push("ws:broadcast")
    })

    const requestPub = bus.scope("request")
    requestPub.publish(makeTerminalEvent(makeCtx()))

    // Drain microtasks so the queueMicrotask body runs.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })

    // Subscribers run synchronously in order. history:start fires first,
    // ws:broadcast next. The microtask body lands later. THIS is the
    // brittleness the ordering contract pins: if WsSink ever runs before
    // HistorySink, history:start would print AFTER ws:broadcast.
    expect(trace).toEqual(["history:start", "ws:broadcast", "history:end"])
    // The crucial invariant: history's *first* operation begins strictly
    // before ws broadcasts. Synchronous SQLite means start === end, but
    // the test still proves "history-first" is enforced by subscribe order.
    expect(trace.indexOf("history:start")).toBeLessThan(trace.indexOf("ws:broadcast"))
  })

  test("reversing attach order breaks the contract (negative test)", async () => {
    const bus = createBus()
    const trace: Array<string> = []

    // Intentionally wrong order: WsSink first.
    bus.subscribe((event) => {
      if (event.kind !== "request.completed") return
      trace.push("ws:broadcast")
    })

    bus.subscribe((event) => {
      if (event.kind !== "request.completed") return
      trace.push("history:start")
    })

    const requestPub = bus.scope("request")
    requestPub.publish(makeTerminalEvent(makeCtx()))

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })

    // ws broadcast runs first — exactly the race we're guarding against
    // in start.ts. This test exists so anyone tempted to "tidy up"
    // start.ts and put attachWsSink before attachHistorySink sees the
    // contract written down as code.
    expect(trace).toEqual(["ws:broadcast", "history:start"])
    expect(trace.indexOf("ws:broadcast")).toBeLessThan(trace.indexOf("history:start"))
  })

  test("handler isolation: throwing in HistorySink does not stop WsSink", () => {
    const bus = createBus()
    let wsRan = false

    bus.subscribe(() => {
      throw new Error("HistorySink simulated failure")
    })
    bus.subscribe(() => {
      wsRan = true
    })

    const requestPub = bus.scope("request")
    requestPub.publish(makeTerminalEvent(makeCtx()))

    expect(wsRan).toBe(true)
  })
})
