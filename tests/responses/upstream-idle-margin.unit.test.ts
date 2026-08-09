/**
 * Phase 4 Task 4.2 — R5.3 idle-guard independence (upstream frame-silence margin).
 *
 * LOCKS the invariant that `state.streamIdleTimeout` (default 300s) is the upstream FRAME-silence
 * ceiling for BOTH the Responses SSE path (`guardSseIterable`, used by responses/handler.ts &
 * responses/fallback.ts) and the Responses WS path (`raceIteratorNext`, used directly by
 * streamWsEvents in upstream-ws-attempt.ts) — the SAME knob — and that it is NOT extended by the
 * downstream client keepalive (Phase 2, `makeSseSink` / `makeWsSink` heartbeat).
 *
 * The two are DELIBERATELY SEPARATE racers (design §3.3 / B2 two-racer):
 *   - downstream keepalive = a SOFT forward-idle racer RESIDENT IN THE SINK (injects client pings so
 *     Codex's OWN 300s reader deadline never trips on a legitimately-reasoning-but-silent upstream);
 *   - the upstream frame-idle guard = a HARD racer RESIDENT IN THE TRANSPORT (kills the stream when
 *     the UPSTREAM sends no frame for `streamIdleTimeout`).
 * A downstream ping is NOT an upstream frame, so it can never reset the upstream guard. If it could,
 * a wedged upstream would be kept alive forever (leaking the connection + never failing over). These
 * tests fire the real downstream keepalive timer THROUGHOUT the silent window and assert the upstream
 * guard STILL idle-kills exactly at `streamIdleTimeout` — they FAIL (the racer stays pending, the
 * `rejects` assertion never settles) if a regression let the downstream keepalive rescue the guard.
 *
 * Margin conclusion (spec R5.3) — see exp/ws-upstream-keepalive/REPORT.md §"Idle-guard margin":
 *   - 300s is the upstream silence ceiling, configurable via `streamIdleTimeout`, NOT compensated by
 *     downstream/connection keepalive. The §1.1 incident was 124s < 300s (the close-code bug, fixed
 *     in Phase 0 — NOT this guard). A legitimate >300s silent reasoning needs a larger
 *     `streamIdleTimeout`; the 300s default is unchanged (it matches Codex's own reader deadline).
 *
 * Deterministic via FakeClock (mirrors owns-sink-two-racer.unit.test.ts): the sink heartbeat timer,
 * the `raceIteratorNext` idle timer, and `Date.now` all read one fake clock, so a single `advance()`
 * drives BOTH racers — no real waits, 0-flaky by construction (verified 10× per Task 4.2 discipline).
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
import {
  //
  makeSseSink,
  makeWsSink,
} from "~/lib/pipeline/client-sink"
import { state } from "~/lib/state"
import {
  //
  StreamIdleTimeoutError,
  guardSseIterable,
  raceIteratorNext,
} from "~/lib/stream"

import { FakeClock } from "../helpers/fake-clock"
import { decodeSseWrite } from "../helpers/sse-write-stream"

// ── The single production knob under test (spec R5.3) ────────────────────────
// Both the SSE guard and the WS racer derive their ceiling from this ONE state field, exactly like
// production (responses/handler.ts, fallback.ts, and upstream-ws-attempt.ts each read it). Asserting
// on `state.streamIdleTimeout` (not a literal) means the test tracks the real default and the real
// "same knob" claim: change the default and both racers move together.
const IDLE_MS = state.streamIdleTimeout * 1000 // 300_000 by default
const KEEPALIVE_INTERVAL_SEC = state.streamKeepalivePingSec // 20 by default

// An upstream that is FRAME-silent from the very first poll — `next()` never resolves. The idle
// timer arms synchronously the moment `guardSseIterable`/`raceIteratorNext` first awaits it (before
// any clock advance), so the fake clock deterministically drives it.
function silentUpstream<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<T>>(() => {}) }
    },
  }
}

// Minimal SSE stream stand-in capturing every writeSSE payload (real + synthetic keepalive frames).
function fakeSseStream(): { stream: Parameters<typeof makeSseSink>[0]; written: Array<{ data: string; event?: string }> } {
  const written: Array<{ data: string; event?: string }> = []
  const stream = {
    write: (input: Uint8Array | string) => (written.push(decodeSseWrite(input)), Promise.resolve()),
  } as unknown as Parameters<typeof makeSseSink>[0]
  return { stream, written }
}

// Minimal WSContext stand-in capturing every ws.send payload (WS frames carry only `data`).
function fakeWs(): { ctx: Parameters<typeof makeWsSink>[0]; sent: Array<string> } {
  const sent: Array<string> = []
  const ctx = { send: (data: string) => void sent.push(data) } as unknown as Parameters<typeof makeWsSink>[0]
  return { ctx, sent }
}

// Attach a settle-tracker without consuming the rejection (so a later `expect().rejects` still sees
// it). Lets us assert the racer is STILL PENDING before the ceiling (the guard hasn't fired early)
// and SETTLED after it — the crux of "downstream keepalive didn't reset the upstream guard".
function trackSettled(p: Promise<unknown>): { settled: () => boolean } {
  let done = false
  p.then(
    () => (done = true),
    () => (done = true),
  )
  return { settled: () => done }
}

/** Flush pending microtasks so a just-settled promise's `.then` has run before we read the flag. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe("R5.3 idle-guard independence — SAME knob (state.streamIdleTimeout) for SSE + WS", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("SSE guardSseIterable: downstream keepalive fires throughout yet the upstream guard STILL idle-kills at streamIdleTimeout", async () => {
    // Real downstream SSE keepalive (Phase 2): the sink's heartbeat timer arms at construction and
    // injects a Responses keepalive frame every KEEPALIVE_INTERVAL_SEC of forward-silence.
    const { stream, written } = fakeSseStream()
    const forwarded: Array<SseEventRecord> = []
    makeSseSink(stream, {
      onForwarded: (r) => forwarded.push(r),
      streamStartMs: clock.now,
      heartbeat: { intervalSec: KEEPALIVE_INTERVAL_SEC, pingFrame: responsesKeepaliveFrame() },
    })

    // Real upstream frame-idle guard (the SSE racer used by responses/handler.ts & fallback.ts).
    const guarded = guardSseIterable(silentUpstream<{ data: string }>(), { idleTimeoutMs: IDLE_MS })
    const iter = guarded[Symbol.asyncIterator]()
    const nextP = iter.next() // arms the idle timer NOW (silent upstream never resolves)
    const guard = trackSettled(nextP)

    // Advance to just before the ceiling. The downstream keepalive fires repeatedly here — but the
    // upstream guard MUST NOT have fired yet (it is not reset, merely not-yet-elapsed).
    await clock.advance(IDLE_MS - 1000)
    await flushMicrotasks()
    const keepalivesBeforeCeiling = written.filter((w) => w.event === "response.ping").length
    expect(keepalivesBeforeCeiling).toBeGreaterThan(0) // downstream keepalive is genuinely active
    expect(guard.settled()).toBe(false) // ...yet the upstream guard has NOT idle-killed early

    // Cross the ceiling. Despite ~15 downstream keepalives already sent, the upstream guard fires.
    await clock.advance(2000) // now IDLE_MS + 1000 total silence
    await expect(nextP).rejects.toBeInstanceOf(StreamIdleTimeoutError)

    // Downstream keepalives kept firing right up to the kill — they never rescued the upstream guard.
    expect(written.filter((w) => w.event === "response.ping").length).toBeGreaterThanOrEqual(keepalivesBeforeCeiling)
    expect(forwarded.filter((f) => f.synthetic === "keepalive").length).toBeGreaterThan(0)
  })

  test("WS raceIteratorNext: downstream WS keepalive fires throughout yet the upstream guard STILL idle-kills at the SAME streamIdleTimeout", async () => {
    // Real downstream WS keepalive (Phase 2 R3.5): makeWsSink's heartbeat sends the app-layer
    // keepalive frame — the WS analog of the SSE ping — every KEEPALIVE_INTERVAL_SEC of silence.
    const { ctx, sent } = fakeWs()
    makeWsSink(ctx, {
      streamStartMs: clock.now,
      heartbeat: { intervalSec: KEEPALIVE_INTERVAL_SEC, pingFrame: responsesKeepaliveFrame() },
    })

    // Real upstream frame-idle guard for WS: the exact `raceIteratorNext` call streamWsEvents makes,
    // deriving idleTimeoutMs from the SAME state.streamIdleTimeout knob.
    const upstream = silentUpstream<{ value: string }>()[Symbol.asyncIterator]()
    const raceP = raceIteratorNext(upstream.next(), { idleTimeoutMs: IDLE_MS })
    const guard = trackSettled(raceP)

    // Just before the ceiling: WS keepalive frames are flowing, upstream guard has NOT fired.
    await clock.advance(IDLE_MS - 1000)
    await flushMicrotasks()
    const wsKeepalivesBeforeCeiling = sent.length
    expect(wsKeepalivesBeforeCeiling).toBeGreaterThan(0) // downstream WS keepalive genuinely active
    expect(guard.settled()).toBe(false) // ...yet the upstream guard has NOT idle-killed early

    // Cross the ceiling → the same knob kills the WS stream too (300s == 300s, R5.3).
    await clock.advance(2000)
    await expect(raceP).rejects.toBeInstanceOf(StreamIdleTimeoutError)
    expect(sent.length).toBeGreaterThanOrEqual(wsKeepalivesBeforeCeiling)
  })

  test("the SSE guard and the WS racer read the identical knob (state.streamIdleTimeout), so they cannot drift", () => {
    // A guard against silent divergence: both paths compute their ceiling from ONE field. If a future
    // change gave WS its own timeout, this fixed relationship (and the two racer tests above sharing
    // IDLE_MS) would no longer hold — the "same knob" claim of R5.3 would be broken.
    expect(IDLE_MS).toBe(state.streamIdleTimeout * 1000)
    expect(state.streamIdleTimeout).toBe(300) // default unchanged (matches Codex's own 300s reader deadline)
  })
})
