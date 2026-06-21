/**
 * Stage B B1 — ClientSink factory behavior (event-line, WS send, single-chain
 * serialization, reject-propagation-without-poisoning).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import {
  //
  makeArraySink,
  makeSseSink,
  makeWsSink,
} from "~/lib/pipeline/client-sink"

describe("makeArraySink", () => {
  test("collects written frames in order", async () => {
    const { sink, frames } = makeArraySink()
    await sink.write({ data: "a" })
    await sink.write({ event: "x", data: "b" })
    expect(frames).toEqual([{ data: "a" }, { event: "x", data: "b" }])
  })

  test("serializes interleaved writes through one chain (FIFO order preserved)", async () => {
    const { sink, frames } = makeArraySink()
    // Fire three writes without awaiting between them — they must land in call order.
    const p = [sink.write({ data: "1" }), sink.write({ data: "2" }), sink.write({ data: "3" })]
    await Promise.all(p)
    expect(frames.map((f) => f.data)).toEqual(["1", "2", "3"])
  })

  test("a rejecting write propagates to the caller but does NOT poison later writes", async () => {
    const { sink, frames } = makeArraySink({ rejectAtFrame: 1 })
    await sink.write({ data: "0" }) // ok
    await expect(sink.write({ data: "1" })).rejects.toThrow(/disconnected mid-write/)
    // Chain stays alive — a subsequent write still runs.
    await sink.write({ data: "2" })
    expect(frames.map((f) => f.data)).toEqual(["0", "2"])
  })
})

describe("makeSseSink", () => {
  function mockStream(): { stream: Parameters<typeof makeSseSink>[0]; writes: Array<unknown> } {
    const writes: Array<unknown> = []
    // Only `writeSSE` is exercised by the sink.
    const stream = { writeSSE: (msg: unknown) => (writes.push(msg), Promise.resolve()) } as unknown as Parameters<typeof makeSseSink>[0]
    return { stream, writes }
  }

  test("writes data + event line; omits event when undefined", async () => {
    const { stream, writes } = mockStream()
    const sink = makeSseSink(stream)
    await sink.write({ event: "message", data: "hi" })
    await sink.write({ data: "[DONE]" })
    expect(writes).toEqual([{ data: "hi", event: "message" }, { data: "[DONE]" }])
  })

  test("undefined data writes an empty string (never undefined)", async () => {
    const { stream, writes } = mockStream()
    await makeSseSink(stream).write({} as ClientFrame)
    expect(writes).toEqual([{ data: "" }])
  })

  test("forwards id/retry SSE framing (faithful passthrough; id stringified, undefined keys omitted)", async () => {
    const { stream, writes } = mockStream()
    const sink = makeSseSink(stream)
    // An upstream frame carrying SSE `id:`/`retry:` framing must be forwarded verbatim —
    // a sink that wrote only event/data would silently narrow the bypass-direct passthrough.
    await sink.write({ event: "message", data: "hi", id: 7, retry: 3000 })
    await sink.write({ event: "message", data: "bye" }) // no id/retry → omitted
    expect(writes).toEqual([
      { data: "hi", event: "message", id: "7", retry: 3000 },
      { data: "bye", event: "message" },
    ])
  })
})

describe("makeWsSink", () => {
  test("sends the frame data string", async () => {
    const sent: Array<string> = []
    const ws = { send: (s: string) => void sent.push(s) } as unknown as Parameters<typeof makeWsSink>[0]
    const sink = makeWsSink(ws)
    await sink.write({ data: '{"type":"x"}' })
    await sink.write({}) // empty → ""
    expect(sent).toEqual(['{"type":"x"}', ""])
  })
})

// ── makeSseSink heartbeat (B2 forward-idle racer) ─────────────────────────────

/** Minimal deterministic clock for the heartbeat timer (mirrors fake-sse-heartbeat's). */
class FakeClock {
  now = 1_000_000
  private nextId = 1
  private timers = new Map<number, { fireAt: number; cb: () => void; cleared?: boolean }>()
  private origSet = globalThis.setTimeout
  private origClear = globalThis.clearTimeout
  private origNow = Date.now
  install(): void {
    Date.now = () => this.now
    ;(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((cb: () => void, ms: number) => {
      const id = this.nextId++
      this.timers.set(id, { fireAt: this.now + ms, cb })
      return id as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    ;(globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      const e = this.timers.get(id as unknown as number)
      if (e) e.cleared = true
    }) as typeof clearTimeout
  }
  restore(): void {
    Date.now = this.origNow
    globalThis.setTimeout = this.origSet
    globalThis.clearTimeout = this.origClear
  }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => !t.cleared && t.fireAt <= target).sort(([, a], [, b]) => a.fireAt - b.fireAt)
      if (due.length === 0) break
      const [id, entry] = due[0]
      this.now = entry.fireAt
      this.timers.delete(id)
      entry.cb()
      await Promise.resolve()
      await Promise.resolve()
    }
    this.now = target
  }
}

function stubSseStream(): { stream: Parameters<typeof makeSseSink>[0]; written: Array<{ data: string; event?: string }> } {
  const written: Array<{ data: string; event?: string }> = []
  const stream = {
    writeSSE: (m: { data: string; event?: string }) => (written.push({ data: m.data, ...(m.event !== undefined && { event: m.event }) }), Promise.resolve()),
  } as unknown as Parameters<typeof makeSseSink>[0]
  return { stream, written }
}

const PING: ClientFrame = { event: "ping", data: '{"type":"ping"}' }

describe("makeSseSink heartbeat (B2 forward-idle racer)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("intervalSec<=0 → no timer, but writeSynthetic/close are always defined (cut-over: H3 needs them with heartbeat off)", async () => {
    const { stream } = stubSseStream()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 0, pingFrame: PING } })
    // writeSynthetic (H3 non-sampled error frame) + close (no-op timer teardown) must
    // always exist — the default Anthropic path runs with anthropicFakeSseHeartbeat=0.
    expect(typeof sink.writeSynthetic).toBe("function")
    expect(typeof sink.close).toBe("function")
  })

  test("injects a ping only after intervalSec of forward-silence", async () => {
    const { stream, written } = stubSseStream()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: PING } })
    await clock.advance(14_000)
    expect(written).toEqual([]) // not yet
    await clock.advance(1_000) // 15s silence → fires
    expect(written).toEqual([{ data: '{"type":"ping"}', event: "ping" }])
    sink.close?.()
  })

  test("a real write resets the countdown — a steady stream never pings", async () => {
    const { stream, written } = stubSseStream()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: PING } })
    for (let i = 0; i < 5; i++) {
      await clock.advance(10_000) // < interval each time
      await sink.write({ data: `f${i}` })
    }
    expect(written.filter((w) => w.event === "ping")).toEqual([]) // no pings
    sink.close?.()
  })

  test("close() clears the timer — no ping after close", async () => {
    const { stream, written } = stubSseStream()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: PING } })
    sink.close?.()
    await clock.advance(60_000)
    expect(written).toEqual([])
  })

  test("aborted clientAbortSignal suppresses pings", async () => {
    const { stream, written } = stubSseStream()
    const ac = new AbortController()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: PING, clientAbortSignal: ac.signal } })
    ac.abort()
    await clock.advance(60_000)
    expect(written).toEqual([])
    sink.close?.()
  })
})

// ── makeSseSink forwarded-track sampling (Anthropic cut-over, onForwarded) ─────

describe("makeSseSink forwarded-track sampling (onForwarded)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("write samples forwarded (parsed type → offset/raw); writeSynthetic does NOT (H3 unsampled)", async () => {
    const { stream, written } = stubSseStream()
    const sampled: Array<{ offsetMs: number; type: string; raw: string }> = []
    const sink = makeSseSink(stream, { onForwarded: (r) => sampled.push(r), streamStartMs: clock.now })

    await clock.advance(100)
    await sink.write({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: 0 }) })
    // H3 synthesized error frame — reaches the WIRE but must NOT be sampled.
    await sink.writeSynthetic?.({ event: "error", data: JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }) })

    // Both frames hit the wire.
    expect(written.length).toBe(2)
    // Only the real write is sampled (type from the parsed JSON, raw = verbatim data).
    expect(sampled).toEqual([{ offsetMs: 100, type: "content_block_delta", raw: JSON.stringify({ type: "content_block_delta", index: 0 }) }])
  })

  test("the heartbeat ping IS sampled into the forwarded track (proxy→client frame)", async () => {
    const { stream } = stubSseStream()
    const sampled: Array<{ offsetMs: number; type: string; raw: string }> = []
    const sink = makeSseSink(stream, {
      onForwarded: (r) => sampled.push(r),
      streamStartMs: clock.now,
      heartbeat: { intervalSec: 15, pingFrame: PING },
    })
    await clock.advance(15_000) // silence → ping fires
    expect(sampled).toEqual([{ offsetMs: 15_000, type: "ping", raw: '{"type":"ping"}' }])
    sink.close?.()
  })

  test("forwarded type falls back to event name then keepalive for non-JSON data", async () => {
    const { stream } = stubSseStream()
    const sampled: Array<{ type: string }> = []
    const sink = makeSseSink(stream, { onForwarded: (r) => sampled.push({ type: r.type }), streamStartMs: clock.now })
    await sink.write({ event: "message", data: "not json" }) // unparseable → event name
    await sink.write({ data: "" }) // no data, no event → keepalive
    expect(sampled).toEqual([{ type: "message" }, { type: "keepalive" }])
  })
})
