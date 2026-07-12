/**
 * Chat Completions downstream keepalive (P3 Task 3, backlog:316 CC leg).
 *
 * Mirrors tests/responses/responses-keepalive.unit.test.ts:
 *   1. `ccKeepaliveFrame` factory — a data-bearing, real `chat.completion.chunk`-shaped empty
 *      delta, decodable by openai-node's SSE decoder with zero special-casing.
 *   2. Sink injection — feeding the frame as `makeSseSink`'s heartbeat pingFrame injects it into
 *      the wire + forwarded track (marked `synthetic:"keepalive"`) after `intervalSec` of forward
 *      silence, driven by the deterministic `FakeClock` (0 flaky by construction).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { SseEventRecord } from "~/lib/history"

import { ccKeepaliveFrame } from "~/lib/codec/openai-cc/keepalive"
import { makeSseSink } from "~/lib/pipeline/client-sink"

import { FakeClock } from "../helpers/fake-clock"

describe("ccKeepaliveFrame", () => {
  test("is a data-bearing SSE frame, valid JSON, real chat.completion.chunk empty-delta shape", () => {
    const f = ccKeepaliveFrame()
    expect(f.data).toBeTruthy() // must be data-bearing — a bare comment resets nothing (O4)
    const parsed = JSON.parse(f.data as string) as { choices?: Array<{ delta?: unknown; index?: unknown; finish_reason?: unknown }> }
    expect(parsed.choices).toHaveLength(1)
    expect(parsed.choices?.[0]?.delta).toEqual({}) // empty delta — inert to accumulation, still real content
    expect(parsed.choices?.[0]?.index).toBe(0)
    expect(parsed.choices?.[0]?.finish_reason).toBe(null) // NOT a terminal chunk — must never look like finish
  })

  test("carries no `event:` line — matches the dominant real CC passthrough wire shape (data-only)", () => {
    expect(ccKeepaliveFrame().event).toBeUndefined()
  })

  test("carries no top-level `error` key (would abort the SDK decoder)", () => {
    const parsed = JSON.parse(ccKeepaliveFrame().data as string) as Record<string, unknown>
    expect("error" in parsed).toBe(false)
  })

  test("returns a fresh object each call (no shared mutable singleton)", () => {
    expect(ccKeepaliveFrame()).not.toBe(ccKeepaliveFrame())
    expect(ccKeepaliveFrame()).toEqual(ccKeepaliveFrame())
  })
})

describe("ccKeepaliveFrame + makeSseSink forward-idle injection", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("forward-idle injects the keepalive chunk, marked synthetic:'keepalive' in the forwarded track", async () => {
    const written: Array<{ data: string; event?: string }> = []
    const forwarded: Array<SseEventRecord> = []
    const stream = {
      writeSSE: (m: { data: string; event?: string }) => (written.push({ data: m.data, ...(m.event !== undefined && { event: m.event }) }), Promise.resolve()),
    } as unknown as Parameters<typeof makeSseSink>[0]

    const sink = makeSseSink(stream, {
      onForwarded: (r) => forwarded.push(r),
      streamStartMs: clock.now,
      heartbeat: { intervalSec: 15, pingFrame: ccKeepaliveFrame() },
    })

    // < interval → nothing yet.
    await clock.advance(14_000)
    expect(written).toEqual([])
    // Crossing the 15s forward-silence boundary → exactly one keepalive fires.
    await clock.advance(1_000)
    const expectedData = JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: null }] })
    expect(written).toEqual([{ data: expectedData }]) // no `event` key — data-only frame
    // The injected chunk is sampled into the forwarded (client-received) track WITH the synthetic
    // marker, so history/UI never mistake a stalled-upstream heartbeat for real upstream content.
    expect(forwarded).toEqual([{ offsetMs: 15_000, type: "message", raw: expectedData, synthetic: "keepalive" }])
    sink.close?.()
  })

  test("a real forwarded frame resets the countdown — a steady stream never pings", async () => {
    const written: Array<{ data: string; event?: string }> = []
    const stream = {
      writeSSE: (m: { data: string; event?: string }) => (written.push({ data: m.data, ...(m.event !== undefined && { event: m.event }) }), Promise.resolve()),
    } as unknown as Parameters<typeof makeSseSink>[0]
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: ccKeepaliveFrame() } })
    for (let i = 0; i < 5; i++) {
      await clock.advance(10_000) // < interval each turn
      await sink.write({ data: JSON.stringify({ choices: [{ delta: { content: "hi" }, index: 0, finish_reason: null }] }) })
    }
    expect(written.filter((w) => w.data.includes('"delta":{}'))).toEqual([]) // no keepalive ever
    sink.close?.()
  })

  test("aborted clientAbortSignal suppresses keepalive chunks", async () => {
    const written: Array<{ data: string; event?: string }> = []
    const stream = {
      writeSSE: (m: { data: string; event?: string }) => (written.push({ data: m.data, ...(m.event !== undefined && { event: m.event }) }), Promise.resolve()),
    } as unknown as Parameters<typeof makeSseSink>[0]
    const ac = new AbortController()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: ccKeepaliveFrame(), clientAbortSignal: ac.signal } })
    ac.abort()
    await clock.advance(60_000)
    expect(written).toEqual([]) // client gone → no keepalive chunks
    sink.close?.()
  })
})
