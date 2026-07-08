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
  mock,
  test,
} from "bun:test"

import type { OpenBlock } from "~/lib/pipeline/client-sink"
import type {
  //
  ClientFrame,
  ClientSink,
} from "~/lib/pipeline/types"

import {
  //
  makeArraySink,
  makeSseSink,
  makeWsSink,
} from "~/lib/pipeline/client-sink"

import { FakeClock } from "../helpers/fake-clock"

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
    // always exist — the default Anthropic path runs with streamKeepalivePingSec=0.
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

  test("freezeHeartbeat stops further pings but write still works (anchor C1 guard)", async () => {
    const { stream, written } = stubSseStream()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 1, pingFrame: PING } })
    // One idle interval → exactly one keepalive fired.
    await clock.advance(1_000)
    expect(written).toEqual([{ data: '{"type":"ping"}', event: "ping" }])
    // Freeze: clears the timer but does NOT close the sink (unlike close(), write stays usable).
    sink.freezeHeartbeat?.()
    // No new synthetic frame across many intervals — the heartbeat is truly stopped.
    await clock.advance(10_000)
    expect(written).toEqual([{ data: '{"type":"ping"}', event: "ping" }])
    // A real write after freeze still reaches the wire (commit/terminal flush can still write).
    await sink.write({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) })
    expect(written).toEqual([
      { data: '{"type":"ping"}', event: "ping" },
      { data: JSON.stringify({ type: "content_block_stop", index: 0 }), event: "content_block_stop" },
    ])
    sink.close?.()
  })

  test("freezeHeartbeat is idempotent and a no-op with no heartbeat", async () => {
    // Idempotent on the heartbeat path (two freezes never throw / never resurrect the timer).
    const { stream: s1, written: w1 } = stubSseStream()
    const sink1 = makeSseSink(s1, { heartbeat: { intervalSec: 1, pingFrame: PING } })
    sink1.freezeHeartbeat?.()
    sink1.freezeHeartbeat?.()
    await clock.advance(10_000)
    expect(w1).toEqual([])
    sink1.close?.()
    // No-op on the heartbeat-off path (timer is always undefined) — still callable, write still works.
    const { stream: s2, written: w2 } = stubSseStream()
    const sink2 = makeSseSink(s2, { heartbeat: { intervalSec: 0, pingFrame: PING } })
    expect(typeof sink2.freezeHeartbeat).toBe("function")
    sink2.freezeHeartbeat?.()
    await sink2.write({ data: "ok" })
    expect(w2).toEqual([{ data: "ok" }])
  })
})

// ── makeSseSink forwarded-track sampling (Anthropic cut-over, onForwarded) ─────

describe("makeSseSink forwarded-track sampling (onForwarded)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("write AND writeSynthetic sample forwarded (a synthesized terminal error IS a proxy→client frame)", async () => {
    const { stream, written } = stubSseStream()
    const sampled: Array<{ offsetMs: number; type: string; raw: string }> = []
    const sink = makeSseSink(stream, { onForwarded: (r) => sampled.push(r), streamStartMs: clock.now })

    await clock.advance(100)
    await sink.write({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: 0 }) })
    // Synthesized terminal error frame — the client receives it, so it MUST be sampled into the
    // forwarded track (richest-data-flow; reverses the earlier Stage-B H3-unsampled B0-c choice).
    await clock.advance(50)
    await sink.writeSynthetic?.({ event: "error", data: JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }) })

    // Both frames hit the wire.
    expect(written.length).toBe(2)
    // Both are sampled (type from the parsed JSON, raw = verbatim data), enqueue-first like `write`.
    expect(sampled).toEqual([
      { offsetMs: 100, type: "content_block_delta", raw: JSON.stringify({ type: "content_block_delta", index: 0 }) },
      { offsetMs: 150, type: "error", raw: JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }) },
    ])
  })

  test("the heartbeat ping IS sampled into the forwarded track (proxy→client frame), marked synthetic", async () => {
    const { stream } = stubSseStream()
    const sampled: Array<{ offsetMs: number; type: string; raw: string; synthetic?: string }> = []
    const sink = makeSseSink(stream, {
      onForwarded: (r) => sampled.push(r),
      streamStartMs: clock.now,
      heartbeat: { intervalSec: 15, pingFrame: PING },
    })
    await clock.advance(15_000) // silence → ping fires
    expect(sampled).toEqual([{ offsetMs: 15_000, type: "ping", raw: '{"type":"ping"}', synthetic: "keepalive" }])
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

  test("heartbeat keepalive is marked synthetic:'keepalive'; real forwarded frames are NOT", async () => {
    const { stream } = stubSseStream()
    const sampled: Array<{ type: string; synthetic?: string }> = []
    const sink = makeSseSink(stream, {
      onForwarded: (r) => sampled.push({ type: r.type, ...(r.synthetic ? { synthetic: r.synthetic } : {}) }),
      streamStartMs: clock.now,
      heartbeat: { intervalSec: 15, pingFrame: PING },
    })
    await sink.write({ event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: 0 }) }) // a REAL upstream frame
    await clock.advance(15_000) // stall → heartbeat keepalive
    // The real content frame carries NO marker; the keepalive is tagged so history/UI/log can tell a
    // stalled-upstream heartbeat apart from genuine content (richest-data-flow observability).
    expect(sampled.find((r) => r.type === "content_block_delta")?.synthetic).toBeUndefined()
    expect(sampled.find((r) => r.type === "ping")?.synthetic).toBe("keepalive")
    sink.close?.()
  })
})

// ── makeSseSink block-aware keepalive (provider pingFrame) ────────────────────
// A provider pingFrame is called with the current open content block so it can inject a
// protocol-legal EMPTY delta (thinking→thinking_delta, text→text_delta) that resets Claude
// Code's 300s no-real-content idle deadline — which a bare `event: ping` does NOT.

describe("makeSseSink block-aware keepalive (provider pingFrame)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  const emptyDeltaFor = (ob?: OpenBlock): ClientFrame => {
    if (ob?.type === "thinking")
      return {
        event: "content_block_delta",
        data: JSON.stringify({ type: "content_block_delta", index: ob.index, delta: { type: "thinking_delta", thinking: "" } }),
      }
    if (ob?.type === "text")
      return { event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: ob.index, delta: { type: "text_delta", text: "" } }) }
    return PING // no open block / unknown type → fallback ping
  }
  const blockStart = (index: number, type: string): ClientFrame => ({
    event: "content_block_start",
    data: JSON.stringify({ type: "content_block_start", index, content_block: { type } }),
  })
  const blockStop = (index: number): ClientFrame => ({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index }) })

  test("provider gets the open thinking block → injects an empty thinking_delta", async () => {
    const { stream, written } = stubSseStream()
    const seen: Array<OpenBlock | undefined> = []
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: (ob) => (seen.push(ob), emptyDeltaFor(ob)) } })
    await sink.write(blockStart(0, "thinking"))
    await clock.advance(15_000)
    expect(seen).toEqual([{ index: 0, type: "thinking" }])
    expect(written.at(-1)).toEqual({
      event: "content_block_delta",
      data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } }),
    })
    sink.close?.()
  })

  test("content_block_stop clears the open block → provider gets undefined (fallback ping)", async () => {
    const { stream, written } = stubSseStream()
    const seen: Array<OpenBlock | undefined> = []
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: (ob) => (seen.push(ob), emptyDeltaFor(ob)) } })
    await sink.write(blockStart(0, "thinking"))
    await sink.write(blockStop(0))
    await clock.advance(15_000)
    expect(seen).toEqual([undefined])
    expect(written.at(-1)).toEqual({ event: "ping", data: '{"type":"ping"}' })
    sink.close?.()
  })

  test("tracks the latest open block across start→stop→start (thinking then text)", async () => {
    const { stream } = stubSseStream()
    const seen: Array<OpenBlock | undefined> = []
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: (ob) => (seen.push(ob), emptyDeltaFor(ob)) } })
    await sink.write(blockStart(0, "thinking"))
    await sink.write(blockStop(0))
    await sink.write(blockStart(1, "text"))
    await clock.advance(15_000)
    expect(seen).toEqual([{ index: 1, type: "text" }])
    sink.close?.()
  })

  test("fixed-frame pingFrame does NOT parse blocks (byte-identical ping mode)", async () => {
    const { stream, written } = stubSseStream()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: PING } })
    await sink.write(blockStart(0, "thinking")) // fixed mode ignores this for keepalive selection
    await clock.advance(15_000)
    expect(written.at(-1)).toEqual({ event: "ping", data: '{"type":"ping"}' })
    sink.close?.()
  })
})

// ── makeSseSink buffered anchor injection (injectAnchor tick branch, empty_text mode) ─────
// In buffered empty_text mode there is NO open block yet when the first idle tick fires (nothing
// has been forwarded). The tick calls the driver/pump-supplied `injectAnchor` closure, which forwards
// message_start + a synthetic empty-text anchor block via the sink's PUBLIC `write` — that lights
// openBlock={0,text}. A second idle tick then sees the open block and emits a real empty text_delta
// (the frame that resets Claude Code's 300s watchdog). If injectAnchor cannot inject yet (returns
// false in the pre-message_start window) the tick falls back to a ping.

describe("makeSseSink buffered anchor injection (injectAnchor tick branch)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  // Block-aware provider: an open text block → empty text_delta@index; nothing open → fallback ping.
  const emptyDeltaFor = (ob?: OpenBlock): ClientFrame => {
    if (ob?.type === "text")
      return { event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: ob.index, delta: { type: "text_delta", text: "" } }) }
    return PING // pre-anchor (no open block) → fallback ping
  }
  // The synthetic anchor content_block_start (equivalent to keepalive-anchor.ts anchorStartFrame()).
  const anchorStartData = JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
  const anchorStart: ClientFrame = { event: "content_block_start", data: anchorStartData }
  // The FakeClock drains 2 microtasks per timer fire; the injectAnchor chain (async closure → serialized
  // public write → the tick's `.then`) needs a few more turns, so flush explicitly after an anchor tick.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  test("first idle tick injects anchor via injectAnchor; the next idle tick emits an empty text_delta", async () => {
    const { stream, written } = stubSseStream()
    // Holder (mirrors the real Task 3/4 bindInjector pattern): injectAnchor forwards the anchor start
    // through the sink's PUBLIC write → noteBlockState lights openBlock={0,text}. Returns true
    // (message_start already seen). The holder lets injectAnchor be `const` yet reach the later sink.
    const ref: { sink?: ClientSink } = {}
    const injectAnchor = mock(async (): Promise<boolean> => {
      await ref.sink?.write(anchorStart)
      return true
    })
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: emptyDeltaFor, injectAnchor } })
    ref.sink = sink

    // First idle interval → openBlock===undefined → tick calls injectAnchor (NOT the provider path).
    await clock.advance(15_000)
    await flush()
    expect(injectAnchor).toHaveBeenCalledTimes(1)
    // The anchor start reached the wire via the public write → openBlock is now {0,text}.
    expect(written).toContainEqual({ event: "content_block_start", data: anchorStartData })

    // Second idle interval → openBlock={0,text} now set → provider path emits an empty text_delta@0
    // (the real keepalive), and injectAnchor is NOT called again.
    await clock.advance(15_000)
    await flush()
    expect(injectAnchor).toHaveBeenCalledTimes(1)
    expect(written.at(-1)).toEqual({
      event: "content_block_delta",
      data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }),
    })
    sink.close?.()
  })

  test("injectAnchor returning false (pre-message_start window) falls back to a ping", async () => {
    const { stream, written } = stubSseStream()
    // Pre-message_start: injectAnchor cannot forward the anchor yet → returns false.
    const injectAnchor = mock(async (): Promise<boolean> => false)
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: emptyDeltaFor, injectAnchor } })

    await clock.advance(15_000)
    await flush()
    expect(injectAnchor).toHaveBeenCalledTimes(1)
    // false → that tick falls back to the provider/ping frame (openBlock still undefined → PING).
    expect(written).toEqual([{ data: '{"type":"ping"}', event: "ping" }])
    sink.close?.()
  })

  test("injectAnchor rejecting (client gone mid-write) still emits one keepalive that tick, then re-arms", async () => {
    const { stream, written } = stubSseStream()
    // injectAnchor rejects — models a `sink.write` failing because the client disconnected mid-inject.
    // The tick's `.catch` must re-arm anchorAttempted AND still emit one keepalive so the "every idle
    // tick emits exactly one frame" invariant holds (no silently-wasted interval).
    const injectAnchor = mock(async (): Promise<boolean> => {
      throw new Error("client disconnected mid-write")
    })
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: emptyDeltaFor, injectAnchor } })

    await clock.advance(15_000)
    await flush()
    expect(injectAnchor).toHaveBeenCalledTimes(1)
    // The reject `.catch` emitted one keepalive (openBlock still undefined → provider yields PING).
    expect(written).toEqual([{ data: '{"type":"ping"}', event: "ping" }])
    // Re-armed: the NEXT idle tick retries injectAnchor (anchorAttempted was reset to false).
    await clock.advance(15_000)
    await flush()
    expect(injectAnchor).toHaveBeenCalledTimes(2)
    sink.close?.()
  })
})
