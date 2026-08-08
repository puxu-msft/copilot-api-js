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

import { decodeSseWrite } from "../helpers/sse-write-stream"
import { FakeClock } from "../helpers/fake-clock"

describe("ccKeepaliveFrame", () => {
  test("is a data-bearing SSE frame, valid JSON, real chat.completion.chunk empty-delta shape", () => {
    const f = ccKeepaliveFrame("gpt-5.4")
    expect(f.data).toBeTruthy() // must be data-bearing — a bare comment resets nothing (O4)
    const parsed = JSON.parse(f.data as string) as {
      id?: unknown
      object?: unknown
      created?: unknown
      model?: unknown
      choices?: Array<{ delta?: unknown; index?: unknown; finish_reason?: unknown }>
    }
    // Completeness (non-blocking review finding): a strict CC-SDK client may per-chunk-validate
    // the envelope, so the frame carries the same four top-level fields a real GHC content chunk
    // does (see exp/cc-keepalive-idle-oracle/mock-upstream.ts's firstChunkFrame) — not just the
    // `choices` shape openai-node's lenient decoder alone requires.
    expect(parsed.id).toBe("chatcmpl-keepalive")
    expect(parsed.object).toBe("chat.completion.chunk")
    expect(typeof parsed.created).toBe("number") // time-based — assert type/presence, not exact value
    expect(parsed.model).toBe("gpt-5.4") // the CURRENT request's resolved model, threaded in by the caller
    expect(parsed.choices).toHaveLength(1)
    expect(parsed.choices?.[0]?.delta).toEqual({}) // empty delta — inert to accumulation, still real content
    expect(parsed.choices?.[0]?.index).toBe(0)
    expect(parsed.choices?.[0]?.finish_reason).toBe(null) // NOT a terminal chunk — must never look like finish
  })

  test("carries no `event:` line — matches the dominant real CC passthrough wire shape (data-only)", () => {
    expect(ccKeepaliveFrame("gpt-5.4").event).toBeUndefined()
  })

  test("carries no top-level `error` key (would abort the SDK decoder)", () => {
    const parsed = JSON.parse(ccKeepaliveFrame("gpt-5.4").data as string) as Record<string, unknown>
    expect("error" in parsed).toBe(false)
  })

  test("threads the CURRENT request's model into the frame (not a fixed constant)", () => {
    const a = JSON.parse(ccKeepaliveFrame("gpt-5.4").data as string) as { model: string }
    const b = JSON.parse(ccKeepaliveFrame("claude-opus-4.8").data as string) as { model: string }
    expect(a.model).toBe("gpt-5.4")
    expect(b.model).toBe("claude-opus-4.8")
  })

  test("returns a fresh object each call (no shared mutable singleton)", () => {
    expect(ccKeepaliveFrame("gpt-5.4")).not.toBe(ccKeepaliveFrame("gpt-5.4"))
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
      write: (input: Uint8Array | string) => (written.push(decodeSseWrite(input)), Promise.resolve()),
    } as unknown as Parameters<typeof makeSseSink>[0]

    // `pingFrame` is built ONCE, here, under the FakeClock's frozen `now` — capture `created` at
    // this exact moment so the assertion below is deterministic rather than a brittle exact
    // timestamp guess (mirrors the FakeClock-driven determinism the rest of this file relies on).
    const pingFrame = ccKeepaliveFrame("gpt-5.4")
    const expectedCreated = (JSON.parse(pingFrame.data as string) as { created: number }).created

    const sink = makeSseSink(stream, {
      onForwarded: (r) => forwarded.push(r),
      streamStartMs: clock.now,
      heartbeat: { intervalSec: 15, pingFrame },
    })

    // < interval → nothing yet.
    await clock.advance(14_000)
    expect(written).toEqual([])
    // Crossing the 15s forward-silence boundary → exactly one keepalive fires.
    await clock.advance(1_000)
    // Load-bearing: this goes red if any field — id/object/created/model/choices — is missing or
    // wrong, or if the `synthetic:"keepalive"` marker below is dropped.
    const expectedData = JSON.stringify({
      id: "chatcmpl-keepalive",
      object: "chat.completion.chunk",
      created: expectedCreated,
      model: "gpt-5.4",
      choices: [{ delta: {}, index: 0, finish_reason: null }],
    })
    expect(written).toEqual([{ data: expectedData }]) // no `event` key — data-only frame
    // The injected chunk is sampled into the forwarded (client-received) track WITH the synthetic
    // marker, so history/UI never mistake a stalled-upstream heartbeat for real upstream content.
    expect(forwarded).toEqual([{ offsetMs: 15_000, type: "message", raw: expectedData, synthetic: "keepalive" }])
    sink.close?.()
  })

  test("a real forwarded frame resets the countdown — a steady stream never pings", async () => {
    const written: Array<{ data: string; event?: string }> = []
    const stream = {
      write: (input: Uint8Array | string) => (written.push(decodeSseWrite(input)), Promise.resolve()),
    } as unknown as Parameters<typeof makeSseSink>[0]
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: ccKeepaliveFrame("gpt-5.4") } })
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
      write: (input: Uint8Array | string) => (written.push(decodeSseWrite(input)), Promise.resolve()),
    } as unknown as Parameters<typeof makeSseSink>[0]
    const ac = new AbortController()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: ccKeepaliveFrame("gpt-5.4"), clientAbortSignal: ac.signal } })
    ac.abort()
    await clock.advance(60_000)
    expect(written).toEqual([]) // client gone → no keepalive chunks
    sink.close?.()
  })
})
