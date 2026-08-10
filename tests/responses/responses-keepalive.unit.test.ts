/**
 * Phase 2 Task 2.1 — Responses SSE downstream keepalive.
 *
 * Two levels:
 *   1. `responsesKeepaliveFrame` factory — a data-bearing SSE frame with a valid-JSON,
 *      clearly-synthetic (`response.ping`) type. Codex resets its 300s stream_idle_timeout on
 *      EVERY emitted SSE event and tolerates an unknown `type` (codex-rs/codex-api/src/sse/
 *      responses.rs: JSON-parse-fail → `continue`; unknown kind → `_ => trace!` then `Ok(None)`),
 *      so this frame resets the idle clock with zero client-visible effect (spec §4).
 *   2. Sink injection — feeding the frame as `makeSseSink`'s heartbeat pingFrame injects it into
 *      the wire + forwarded track (marked `synthetic:"keepalive"`) after `intervalSec` of forward
 *      silence. Driven by the deterministic `FakeClock` (no real-timer flakiness → 0 flaky by
 *      construction; the plan's real-`setTimeout` variant is replaced with the fake clock).
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

import { responsesKeepaliveFrame } from "~/lib/codec/openai-responses/keepalive"
import { makeSseSink } from "~/lib/pipeline/client-sink"

import { FakeClock } from "../helpers/fake-clock"
import { decodeSseWrite } from "../helpers/sse-write-stream"

describe("responsesKeepaliveFrame", () => {
  test("is a data-bearing SSE frame with a valid-JSON, synthetic (non-real) type", () => {
    const f = responsesKeepaliveFrame()
    expect(f.data).toBeTruthy() // Codex resets idle only on data-bearing emitted events (§4)
    const parsed = JSON.parse(f.data as string) as { type?: unknown }
    expect(typeof parsed.type).toBe("string") // valid JSON with a type
    expect(parsed.type).toMatch(/ping/) // clearly-synthetic, not a real Responses event
    expect(f.event).toBe(parsed.type as string) // SSE event line mirrors the JSON type
  })

  test("carries NO `error` key (the OpenAI Node SSE decoder throws on a top-level data.error)", () => {
    // O4: openai-node's core/streaming.ts (vendored 6.45.0) passes unknown event types through; its
    // three throw sites are all avoided by this frame (valid JSON → no parse throw; no top-level
    // `error` key → no APIError; event != 'error' and not `thread.*`). Guard the `error`-key one here.
    const parsed = JSON.parse(responsesKeepaliveFrame().data as string) as Record<string, unknown>
    expect("error" in parsed).toBe(false)
  })

  test("returns a fresh object each call (no shared mutable singleton)", () => {
    expect(responsesKeepaliveFrame()).not.toBe(responsesKeepaliveFrame())
    expect(responsesKeepaliveFrame()).toEqual(responsesKeepaliveFrame())
  })
})

describe("responsesKeepaliveFrame + makeSseSink forward-idle injection", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("forward-idle injects the keepalive frame, marked synthetic:'keepalive' in the forwarded track", async () => {
    const written: Array<{ data: string; event?: string }> = []
    const forwarded: Array<SseEventRecord> = []
    const stream = {
      write: (input: Uint8Array | string) => (written.push(decodeSseWrite(input)), Promise.resolve()),
    } as unknown as Parameters<typeof makeSseSink>[0]

    const sink = makeSseSink(stream, {
      onForwarded: (r) => forwarded.push(r),
      streamStartMs: clock.now,
      heartbeat: { intervalSec: 20, pingFrame: responsesKeepaliveFrame() },
    })

    // < interval → nothing yet.
    await clock.advance(19_000)
    expect(written).toEqual([])
    // Crossing the 20s forward-silence boundary → exactly one keepalive fires.
    await clock.advance(1_000)
    expect(written).toEqual([{ data: JSON.stringify({ type: "response.ping" }), event: "response.ping" }])
    // The injected frame is sampled into the forwarded (client-received) track WITH the synthetic marker,
    // so history/UI never mistake a stalled-upstream heartbeat for a real Responses event.
    expect(forwarded).toEqual([{ offsetMs: 20_000, type: "response.ping", raw: JSON.stringify({ type: "response.ping" }), synthetic: "keepalive" }])
    sink.close?.()
  })

  test("a real forwarded frame resets the countdown — a steady stream never pings", async () => {
    const written: Array<{ data: string; event?: string }> = []
    const stream = {
      write: (input: Uint8Array | string) => (written.push(decodeSseWrite(input)), Promise.resolve()),
    } as unknown as Parameters<typeof makeSseSink>[0]
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 20, pingFrame: responsesKeepaliveFrame() } })
    for (let i = 0; i < 5; i++) {
      await clock.advance(15_000) // < interval each turn
      await sink.write({ event: "response.output_text.delta", data: JSON.stringify({ type: "response.output_text.delta" }) })
    }
    expect(written.filter((w) => w.event === "response.ping")).toEqual([]) // no keepalive ever
    sink.close?.()
  })

  test("aborted clientAbortSignal suppresses keepalive pings", async () => {
    const written: Array<{ data: string; event?: string }> = []
    const stream = {
      write: (input: Uint8Array | string) => (written.push(decodeSseWrite(input)), Promise.resolve()),
    } as unknown as Parameters<typeof makeSseSink>[0]
    const ac = new AbortController()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 20, pingFrame: responsesKeepaliveFrame(), clientAbortSignal: ac.signal } })
    ac.abort()
    await clock.advance(60_000)
    expect(written).toEqual([]) // client gone → no pings
    sink.close?.()
  })
})
