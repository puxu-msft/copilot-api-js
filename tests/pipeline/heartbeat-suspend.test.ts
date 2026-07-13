/**
 * P1 Task 3 — per-block flush heartbeat SUSPEND/RESUME (spec 2026-07-11-block-level-buffered-retry §4.4).
 *
 * The block-level buffered path flushes each committed block through a `for (frame of block) await
 * sink.write(frame)` loop. Every `await` yields the event loop, so a heartbeat tick firing mid-flush
 * would splice an EMPTY delta into the middle of a REAL block's deltas (pollution). The whole-response
 * path used `freezeHeartbeat` (PERMANENT — clears the timer, never resumes), which is wrong per-block:
 * after the first block the heartbeat would be dead for the whole inter-block idle. §4.4 needs a
 * RECOVERABLE pair — suspend the heartbeat DURING each block flush, resume it AFTER — so the inter-block
 * gaps still get keepalives while no tick ever pollutes an in-flight block.
 *
 * Two layers under test:
 *   1. the sink primitives (`suspendHeartbeat`/`resumeHeartbeat`) — fake-timer determinism.
 *   2. the driver wrapping the block-level boundary flush with suspend()...resume().
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ClientFrame,
  ClientSink,
  RunBufferedOpts,
} from "~/lib/pipeline/types"

import {
  //
  makeArraySink,
  makeSseSink,
} from "~/lib/pipeline/client-sink"
import { runResponseBufferedSink } from "~/lib/pipeline/driver"

import { FakeClock } from "../helpers/fake-clock"
import { makeBufferedHarness } from "./helpers/buffered-harness"

const PING: ClientFrame = { event: "ping", data: '{"type":"ping"}' }

function stubSseStream(): { stream: Parameters<typeof makeSseSink>[0]; written: Array<{ data: string; event?: string }> } {
  const written: Array<{ data: string; event?: string }> = []
  const stream = {
    writeSSE: (m: { data: string; event?: string }) => (written.push({ data: m.data, ...(m.event !== undefined && { event: m.event }) }), Promise.resolve()),
  } as unknown as Parameters<typeof makeSseSink>[0]
  return { stream, written }
}

// ── the sink primitives (fake-timer) ──────────────────────────────────────────

describe("makeSseSink suspend/resume heartbeat (§4.4 recoverable per-block guard)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("suspend halts ticks across MANY intervals; resume re-arms a fresh interval", async () => {
    const { stream, written } = stubSseStream()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: PING } })

    // Baseline: one idle interval → exactly one ping (proves the timer is live).
    await clock.advance(15_000)
    expect(written).toEqual([{ data: '{"type":"ping"}', event: "ping" }])

    // SUSPEND: a tick that fires now (or across several intervals) must inject NOTHING — this is the
    // pollution guard for the mid-flush window. Advancing 3 full intervals fires the pending tick,
    // which must early-return without injecting AND without leaving a live rescheduled timer.
    sink.suspendHeartbeat?.()
    await clock.advance(45_000)
    expect(written).toEqual([{ data: '{"type":"ping"}', event: "ping" }]) // still just the baseline ping

    // RESUME: re-arms a FRESH interval counted from resume (lastRealMs reset). No premature ping
    // before the interval; a ping AFTER one interval proves the heartbeat truly recovered.
    sink.resumeHeartbeat?.()
    await clock.advance(14_000)
    expect(written).toEqual([{ data: '{"type":"ping"}', event: "ping" }]) // not yet (interval not elapsed since resume)
    await clock.advance(1_000)
    expect(written).toEqual([
      { data: '{"type":"ping"}', event: "ping" },
      { data: '{"type":"ping"}', event: "ping" },
    ])
    sink.close?.()
  })

  test("resume does not double-arm when no tick fired during the suspension window", async () => {
    // The common case: a fast block flush suspends + resumes WITHIN one interval (no tick fires). Resume
    // must leave EXACTLY one live timer (not two) — otherwise the next idle would emit two pings at once.
    const { stream, written } = stubSseStream()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: PING } })
    await clock.advance(5_000) // partway into the first interval, no tick yet
    expect(clock.liveTimerCount).toBe(1) // the single construction-armed timer
    sink.suspendHeartbeat?.()
    sink.resumeHeartbeat?.() // suspend→resume with no intervening tick
    // DIRECT invariant oracle (§4.4 clearTimeout-first): resume's rearm must CLEAR the still-live
    // construction timer before arming the fresh one — so exactly ONE live timer remains. This is the
    // load-bearing guard: the ping-count assertion below is BLIND to a leaked timer here, because the
    // leaked timer fires at t+15000 with elapsed=10000 < interval and merely reschedules (no ping). Only
    // the live-timer count distinguishes "rearm cleared the old timer" from "rearm leaked a second one".
    expect(clock.liveTimerCount).toBe(1)
    await clock.advance(15_000) // one full interval since resume
    expect(written).toEqual([{ data: '{"type":"ping"}', event: "ping" }]) // exactly ONE ping, not two
    sink.close?.()
  })

  test("resume is an idempotent no-op when not suspended, and defined on the heartbeat sink", async () => {
    const { stream, written } = stubSseStream()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: PING } })
    expect(typeof sink.suspendHeartbeat).toBe("function")
    expect(typeof sink.resumeHeartbeat).toBe("function")
    // resume without a prior suspend must not arm a second timer / change cadence.
    sink.resumeHeartbeat?.()
    await clock.advance(15_000)
    expect(written).toEqual([{ data: '{"type":"ping"}', event: "ping" }]) // one ping from the single, unperturbed timer
    sink.close?.()
  })

  test("suspend/resume are always-defined primitives even with the heartbeat OFF (no-op)", async () => {
    const { stream, written } = stubSseStream()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 0, pingFrame: PING } })
    expect(typeof sink.suspendHeartbeat).toBe("function")
    expect(typeof sink.resumeHeartbeat).toBe("function")
    sink.suspendHeartbeat?.()
    sink.resumeHeartbeat?.()
    await sink.write({ data: "ok" }) // write still works after a no-op suspend/resume
    await clock.advance(60_000)
    expect(written).toEqual([{ data: "ok" }]) // never a ping (heartbeat off)
  })
})

// ── the driver wraps the block-level boundary flush ───────────────────────────

/** A recording sink: wraps `makeArraySink` and logs suspend/resume relative to writes. */
function makeRecordingSink(): { sink: ClientSink; log: Array<string> } {
  const { sink: base, frames } = makeArraySink()
  const log: Array<string> = []
  const sink: ClientSink = {
    write: (frame) => {
      const type = (() => {
        try {
          return (JSON.parse(frame.data ?? "{}") as { type?: string }).type ?? "?"
        } catch {
          return "?"
        }
      })()
      log.push(`write:${type}`)
      return base.write(frame)
    },
    suspendHeartbeat: () => log.push("suspend"),
    resumeHeartbeat: () => log.push("resume"),
    freezeHeartbeat: () => log.push("freeze"),
  }
  void frames
  return { sink, log }
}

function d(obj: Record<string, unknown>): ClientFrame {
  return { data: JSON.stringify(obj) } as ClientFrame
}

function boundaryOn(types: Array<string>): (f: ClientFrame) => boolean {
  return (f) => {
    try {
      return types.includes((JSON.parse(f.data ?? "{}") as { type?: string }).type ?? "")
    } catch {
      return false
    }
  }
}

describe("driver wraps the block-level boundary flush with suspend/resume", () => {
  test("each boundary flush is bracketed suspend → writes → resume; terminal-only path never suspends", async () => {
    // Two blocks; each content_block_stop is a commit boundary. The driver must suspend before each
    // boundary flush's write loop and resume after, so the inter-block idle keeps its heartbeat.
    const frames: Array<ClientFrame> = [
      d({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      d({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
      d({ type: "content_block_stop", index: 0 }), // boundary → commit block 0
      d({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
      d({ type: "content_block_stop", index: 1 }), // boundary → commit block 1
      d({ type: "message_stop" }),
    ]
    const h = makeBufferedHarness(frames, { sawMessageStop: true })
    const { sink, log } = makeRecordingSink()

    const outcome = await runResponseBufferedSink(h.deps, h.upstream, h.env, sink, {
      ...h.opts,
      commitBoundaries: boundaryOn(["content_block_stop"]),
      sawMessageStop: () => true,
    } as RunBufferedOpts)

    expect(outcome.kind).toBe("complete")
    // Each block-0/block-1 boundary flush is bracketed by suspend/resume; the writes fall BETWEEN them.
    // (`flushBufferedFrames` also calls its internal `freezeHeartbeat` between the suspend and the writes —
    // resume re-arms what that freeze killed, which is precisely the §4.4 inter-block recovery. The terminal
    // message_stop tail flush is a whole-buffer terminal commit — freeze-only, not a per-block boundary.)
    const suspendIdx = log.indexOf("suspend")
    const resumeIdx = log.indexOf("resume")
    expect(suspendIdx).toBeGreaterThanOrEqual(0)
    expect(resumeIdx).toBeGreaterThan(suspendIdx)
    // block-0 writes sit strictly between the first suspend and the first resume.
    const firstBlockWrites = log.slice(suspendIdx + 1, resumeIdx).filter((x) => x.startsWith("write:"))
    expect(firstBlockWrites).toEqual(["write:content_block_start", "write:content_block_delta", "write:content_block_stop"])
    // suspend precedes the internal freeze inside the bracket (suspend BEFORE the flush loop's freeze).
    expect(log.slice(suspendIdx + 1, resumeIdx).indexOf("freeze")).toBeGreaterThanOrEqual(0)
    // exactly two boundary brackets (one per committed block), balanced.
    expect(log.filter((x) => x === "suspend")).toHaveLength(2)
    expect(log.filter((x) => x === "resume")).toHaveLength(2)
  })

  test("terminal-only path (commitBoundaries undefined) never calls suspend/resume (R1 byte-neutral)", async () => {
    const frames: Array<ClientFrame> = [
      d({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      d({ type: "content_block_stop", index: 0 }),
      d({ type: "message_stop" }),
    ]
    const h = makeBufferedHarness(frames, { sawMessageStop: true })
    const { sink, log } = makeRecordingSink()

    const outcome = await runResponseBufferedSink(h.deps, h.upstream, h.env, sink, {
      ...h.opts,
      sawMessageStop: () => true,
      // no commitBoundaries → terminal-only whole-response commit
    } as RunBufferedOpts)

    expect(outcome.kind).toBe("complete")
    expect(log.filter((x) => x === "suspend" || x === "resume")).toEqual([]) // never suspended on the non-block path
  })
})
