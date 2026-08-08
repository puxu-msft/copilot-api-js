/**
 * Stage B Anthropic cut-over — owns-sink TWO-RACER integration + abort-zero-bytes.
 *
 * The two racers (design §3.3 / B0-e) are deliberately SEPARATE:
 *   - the sink's heartbeat = a SOFT forward-idle racer (injects client pings),
 *   - the transport's `guardSseIterable` = a HARD upstream-idle racer (kills the stream).
 *
 * This is the first point both can be exercised together (B2/B3a deferred it here):
 * with the heartbeat ON and the upstream SILENT, the client must receive pings AND the
 * stream must still die by `idleTimeoutMs` — proving the heartbeat does NOT keep a
 * silent-upstream stream alive forever (it never touches the upstream-idle guard).
 *
 * Plus the B0-d "client-abort → zero further bytes" invariant: a client disconnect
 * settles `settled-abort` and the driver writes no terminal frame to the dead stream.
 *
 * Deterministic via a fake clock (mirrors fake-sse-heartbeat.unit.test.ts) — both the
 * heartbeat timer and `raceIteratorNext`'s idle timer use the overridden global timers,
 * so a single clock drives both racers; no real waits, no flakiness.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  ClientFrame,
  FormatCodec,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"

import { makeSseSink } from "~/lib/pipeline/client-sink"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { guardSseIterable } from "~/lib/stream"

import { decodeSseWrite } from "../helpers/sse-write-stream"
import { FakeClock } from "../helpers/fake-clock"

// ── minimal identity driver scaffolding ──────────────────────────────────────

/** Identity codec — runResponseSink only ever calls `renderResponse` (passthrough). */
const identityCodec = {
  format: "anthropic",
  renderResponse: (frame: UpstreamFrame) => frame,
} as unknown as FormatCodec

function makeDriver(): ReturnType<typeof createPipelineDriver> {
  return createPipelineDriver({
    codec: identityCodec,
    transport: { send: () => Promise.reject(new Error("unused")) },
    strategies: [],
    maxRetries: 3,
    maxLearningRetries: 32,
  })
}

/** Minimal env — runResponse only touches `env.ctx.setSseEvents`. */
function makeEnv(): RequestEnvelope {
  return { clientFormat: "anthropic", ctx: { setSseEvents: () => undefined } } as unknown as RequestEnvelope
}

function stubSseStream(): { stream: Parameters<typeof makeSseSink>[0]; written: Array<{ data: string; event?: string }> } {
  const written: Array<{ data: string; event?: string }> = []
  const stream = {
    write: (input: Uint8Array | string) => (written.push(decodeSseWrite(input)), Promise.resolve()),
  } as unknown as Parameters<typeof makeSseSink>[0]
  return { stream, written }
}

const PING: ClientFrame = { event: "ping", data: '{"type":"ping"}' }

describe("owns-sink two-racer integration (heartbeat SOFT vs upstream-idle HARD)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("heartbeat ON + silent upstream → client gets pings AND the stream still idle-kills", async () => {
    // An upstream that is silent from the first frame (next() never resolves). The guard's
    // idle timer arms synchronously when runResponseSink starts (before any clock advance),
    // so a single fake clock deterministically drives BOTH racers.
    const silent: AsyncIterable<UpstreamFrame> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
    }
    const guarded = guardSseIterable(silent, { idleTimeoutMs: 30_000 })
    const upstream: UpstreamStream = { frames: guarded, headers: new Headers() }

    const { stream, written } = stubSseStream()
    const forwarded: Array<{ type: string }> = []
    const sink = makeSseSink(stream, {
      onForwarded: (r) => forwarded.push({ type: r.type }),
      streamStartMs: clock.now,
      heartbeat: { intervalSec: 10, pingFrame: PING },
    })

    const outcomeP = makeDriver().runResponseSink(upstream, makeEnv(), sink)
    // CandidateResponseSession adds one async generator hand-off before the guard's first next().
    // Flush microtasks so both heartbeat and upstream-idle timers are armed before fake time moves.
    await Promise.resolve()
    await Promise.resolve()

    // The SOFT forward-idle racer injects a ping every 10s of silence.
    await clock.advance(10_000) // ping #1
    await clock.advance(10_000) // ping #2
    expect(written.filter((w) => w.event === "ping").length).toBe(2)

    // ...but the HARD upstream-idle racer still kills at 30s — the heartbeat did NOT keep
    // the silent stream alive forever (the two racers are separate; design §3.3).
    await clock.advance(10_000) // 30s total silence → guard idle-timeout fires
    const outcome = await outcomeP
    expect(outcome.kind).toBe("stream-error") // idle-timeout, NOT settled-abort

    // Pings are proxy→client frames: they appear in the forwarded track.
    expect(forwarded.filter((f) => f.type === "ping").length).toBeGreaterThanOrEqual(2)
  })

  test("decoder probe observes an encoded ping written by the sink", async () => {
    const { stream, written } = stubSseStream()
    const sink = makeSseSink(stream, { streamStartMs: clock.now })

    await sink.write(PING)

    expect(written).toEqual([PING])
  })

  test("client-abort → settled-abort, zero terminal bytes written to the dead stream", async () => {
    const ac = new AbortController()
    async function* abortAfterOne(): AsyncIterable<UpstreamFrame> {
      yield { event: "message_start", data: JSON.stringify({ type: "message_start" }) }
      ac.abort() // client disconnects
      await new Promise<never>(() => {}) // block so the abort wins the next() race
    }
    const guarded = guardSseIterable(abortAfterOne(), { idleTimeoutMs: 30_000, clientSignal: ac.signal })
    const upstream: UpstreamStream = { frames: guarded, headers: new Headers() }

    const { stream, written } = stubSseStream()
    const sink = makeSseSink(stream, { streamStartMs: clock.now })

    const outcomeP = makeDriver().runResponseSink(upstream, makeEnv(), sink)
    await clock.advance(1) // let the generator advance past the abort
    const outcome = await outcomeP

    expect(outcome.kind).toBe("settled-abort")
    // Only the one real frame reached the wire — runResponseSink wrote NO terminal error
    // frame to the dead stream (the handler's settled-abort branch returns without writing).
    expect(written).toEqual([{ data: JSON.stringify({ type: "message_start" }), event: "message_start" }])
  })
})
