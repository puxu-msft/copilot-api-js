import type { SSEStreamingApi } from "hono/streaming"

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { SseEventRecord } from "~/lib/history/store"

import { startForwardedSseHeartbeat } from "~/routes/messages/web-search-direct"

/**
 * Tests for the synthetic SSE heartbeat (anthropic.stream_fake_sse_heartbeat). Uses
 * a fake timer + a stub SSEStreamingApi so the suite stays deterministic and
 * fast (no real wait).
 */

interface WrittenFrame {
  data: string
  event?: string
  id?: string
}

function makeStubStream(): { stream: SSEStreamingApi; written: Array<WrittenFrame> } {
  const written: Array<WrittenFrame> = []
  const stream = {
    writeSSE: async (m: { data: string; event?: string; id?: string }) => {
      written.push({ data: m.data, event: m.event, id: m.id })
    },
  } as unknown as SSEStreamingApi
  return { stream, written }
}

interface TimerEntry {
  fireAt: number
  cb: () => void
  cleared?: boolean
}

class FakeClock {
  now = 1_000_000
  private nextId = 1
  private timers = new Map<number, TimerEntry>()
  private originalSetTimeout = globalThis.setTimeout
  private originalClearTimeout = globalThis.clearTimeout
  private originalDateNow = Date.now

  install(): void {
    Date.now = () => this.now
    ;(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((cb: () => void, ms: number) => {
      const id = this.nextId++
      this.timers.set(id, { fireAt: this.now + ms, cb })
      return id as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    ;(globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      const entry = this.timers.get(id as unknown as number)
      if (entry) entry.cleared = true
    }) as typeof clearTimeout
  }

  restore(): void {
    Date.now = this.originalDateNow
    globalThis.setTimeout = this.originalSetTimeout
    globalThis.clearTimeout = this.originalClearTimeout
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    while (true) {
      const due = [...this.timers.entries()].filter(([, t]) => !t.cleared && t.fireAt <= target).sort(([, a], [, b]) => a.fireAt - b.fireAt)
      if (due.length === 0) break
      const [id, entry] = due[0]
      this.now = entry.fireAt
      this.timers.delete(id)
      entry.cb()
      // Let microtasks (pending writeSerialized awaits) drain so subsequent
      // assertions see all forwarded frames before continuing.
      await Promise.resolve()
      await Promise.resolve()
    }
    this.now = target
  }
}

describe("stream_fake_sse_heartbeat", () => {
  const clock = new FakeClock()
  beforeEach(() => {
    clock.install()
  })
  afterEach(() => {
    clock.restore()
  })

  test("intervalSec=0 is a passthrough — no timer, noteRealFrame/stop are no-ops", async () => {
    const { stream, written } = makeStubStream()
    const forwardedSseEvents: Array<SseEventRecord> = []
    const hb = startForwardedSseHeartbeat({
      intervalSec: 0,
      stream,
      forwardedSseEvents,
      streamState: { streamStartMs: clock.now, bytesIn: 0, eventsIn: 0, currentBlockType: "", firstEventLogged: false, recoverFeatureLogged: false },
      clientAbortSignal: undefined,
    })
    hb.noteRealFrame() // safe no-op
    await hb.writeSerialized({ data: "hello", event: "message" })
    await clock.advance(10 * 60 * 1000)
    hb.stop() // safe no-op
    expect(written).toEqual([{ data: "hello", event: "message", id: undefined }])
    expect(forwardedSseEvents).toEqual([])
  })

  test("emits a `ping` only after `intervalSec` seconds of upstream silence", async () => {
    const { stream, written } = makeStubStream()
    const forwardedSseEvents: Array<SseEventRecord> = []
    const startMs = clock.now
    const hb = startForwardedSseHeartbeat({
      intervalSec: 15,
      stream,
      forwardedSseEvents,
      streamState: { streamStartMs: startMs, bytesIn: 0, eventsIn: 0, currentBlockType: "", firstEventLogged: false, recoverFeatureLogged: false },
      clientAbortSignal: undefined,
    })

    await clock.advance(14_000)
    expect(written).toEqual([]) // not yet

    await clock.advance(1_000) // total 15s of silence — fires
    expect(written.length).toBe(1)
    expect(written[0]).toEqual({ data: JSON.stringify({ type: "ping" }), event: "ping", id: undefined })
    expect(forwardedSseEvents).toEqual([{ offsetMs: 15_000, type: "ping", raw: JSON.stringify({ type: "ping" }) }])

    hb.stop()
  })

  test("noteRealFrame resets the countdown so a steady stream never emits a ping", async () => {
    const { stream, written } = makeStubStream()
    const hb = startForwardedSseHeartbeat({
      intervalSec: 15,
      stream,
      forwardedSseEvents: [],
      streamState: { streamStartMs: clock.now, bytesIn: 0, eventsIn: 0, currentBlockType: "", firstEventLogged: false, recoverFeatureLogged: false },
      clientAbortSignal: undefined,
    })

    // 4 real frames at 10s spacing → each resets, timer never fires.
    for (let i = 0; i < 4; i++) {
      await clock.advance(10_000)
      hb.noteRealFrame()
      await hb.writeSerialized({ data: `frame-${i}` })
    }
    expect(written.length).toBe(4)
    expect(written.every((f) => f.data.startsWith("frame-"))).toBe(true)
    // Now go silent for the full interval — that should fire exactly once.
    await clock.advance(15_000)
    expect(written.length).toBe(5)
    expect(written[4]).toEqual({ data: JSON.stringify({ type: "ping" }), event: "ping", id: undefined })

    hb.stop()
  })

  test("stop() cancels the pending timer — no further pings after stop", async () => {
    const { stream, written } = makeStubStream()
    const hb = startForwardedSseHeartbeat({
      intervalSec: 15,
      stream,
      forwardedSseEvents: [],
      streamState: { streamStartMs: clock.now, bytesIn: 0, eventsIn: 0, currentBlockType: "", firstEventLogged: false, recoverFeatureLogged: false },
      clientAbortSignal: undefined,
    })
    await clock.advance(10_000)
    hb.stop()
    await clock.advance(60_000)
    expect(written).toEqual([])
  })

  test("aborted clientAbortSignal suppresses pings even if the timer fires", async () => {
    const { stream, written } = makeStubStream()
    const controller = new AbortController()
    const hb = startForwardedSseHeartbeat({
      intervalSec: 15,
      stream,
      forwardedSseEvents: [],
      streamState: { streamStartMs: clock.now, bytesIn: 0, eventsIn: 0, currentBlockType: "", firstEventLogged: false, recoverFeatureLogged: false },
      clientAbortSignal: controller.signal,
    })
    controller.abort()
    await clock.advance(15_000)
    expect(written).toEqual([])
    hb.stop()
  })

  test("real frame just before timer fire reschedules to exactly intervalMs after that frame (worst case)", async () => {
    // Regression for the self-correcting reschedule branch: if a real frame
    // arrives 1ms before the timer would fire, we don't want the next ping
    // pushed out by another full interval — we want it exactly intervalMs
    // after the latest real frame.
    const { stream, written } = makeStubStream()
    const hb = startForwardedSseHeartbeat({
      intervalSec: 15,
      stream,
      forwardedSseEvents: [],
      streamState: { streamStartMs: clock.now, bytesIn: 0, eventsIn: 0, currentBlockType: "", firstEventLogged: false, recoverFeatureLogged: false },
      clientAbortSignal: undefined,
    })

    // 14.999s in, a real frame lands.
    await clock.advance(14_999)
    hb.noteRealFrame()
    await hb.writeSerialized({ data: "late-frame" })
    expect(written.length).toBe(1)

    // The originally-scheduled timer fires at 15.000s, sees elapsed=1ms,
    // reschedules for intervalMs - elapsed = 14_999ms (target wakeup at
    // 14_999 + 15_000 = 29_999). It must NOT emit a ping yet.
    await clock.advance(1)
    expect(written.length).toBe(1)

    // Silence for the remainder of the next interval — at exactly
    // intervalMs since the last real frame, the ping fires.
    await clock.advance(14_999)
    expect(written.length).toBe(2)
    expect(written[1]).toEqual({ data: JSON.stringify({ type: "ping" }), event: "ping", id: undefined })

    hb.stop()
  })
})
