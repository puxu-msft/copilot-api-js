/**
 * C1 fix — the SSE sink's open-block tracker is a STACK, not a single slot (block-level buffered retry).
 *
 * The bug this locks down: with a single-slot `openBlock`, an anchor@0 that stays OPEN beneath a real
 * block@+1 gets OVERWRITTEN when the real block's `content_block_start@1` is noted, and then CLEARED by
 * the real block's `content_block_stop@1`. Once the real block closes, the inter-block silence tick sees
 * `openBlock===undefined` and falls back to a BARE `event: ping` — which does NOT reset Claude Code's 300s
 * no-real-content idle deadline (exp/cc-idle-280s/REPORT.md). The client disconnects at 300s.
 *
 * With a block STACK the anchor@0 sits at the bottom the whole stream; a real block@+1 push/pops ABOVE it,
 * and when the real block closes the stack falls back to the anchor → the tick emits an empty `text_delta@0`
 * (real content that DOES reset the 300s deadline), not a bare ping.
 *
 * The provider is the REAL {@link makeAnthropicKeepaliveFrame} + the REAL anchor frame builders (an
 * independent wire oracle — the test never hand-rolls the keepalive shape it asserts).
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

import { anchorStartFrame } from "~/lib/anthropic/keepalive-anchor"
import { makeAnthropicKeepaliveFrame } from "~/lib/anthropic/keepalive-frame"
import { makeSseSink } from "~/lib/pipeline/client-sink"

import { decodeSseWrite } from "../helpers/sse-write-stream"
import { FakeClock } from "../helpers/fake-clock"

function stubSseStream(): { stream: Parameters<typeof makeSseSink>[0]; written: Array<{ data: string; event?: string }> } {
  const written: Array<{ data: string; event?: string }> = []
  const stream = {
    write: (input: Uint8Array | string) => (written.push(decodeSseWrite(input)), Promise.resolve()),
  } as unknown as Parameters<typeof makeSseSink>[0]
  return { stream, written }
}

/** A real content_block_start@index of a given block type (thinking/text/…). */
const blockStart = (index: number, type: string): ClientFrame => ({
  event: "content_block_start",
  data: JSON.stringify({ type: "content_block_start", index, content_block: { type } }),
})
/** A real content_block_stop@index. */
const blockStop = (index: number): ClientFrame => ({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index }) })

/** The empty text_delta@0 the anchor's block-aware keepalive resolves to — the frame that resets CC's 300s watchdog. */
const anchorTextDelta0 = makeAnthropicKeepaliveFrame({ index: 0, type: "text" })
const BARE_PING = { data: '{"type":"ping"}', event: "ping" }

/** Normalize a ClientFrame to the `{ data, event? }` shape the stub records (event omitted when undefined). */
const wire = (f: ClientFrame): { data: string; event?: string } => ({ data: f.data ?? "", ...(f.event !== undefined ? { event: f.event } : {}) })

describe("makeSseSink open-block STACK — inter-block keepalive rides the anchor (C1 fix)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("anchor@0 open + real block@1 start/stop → inter-block tick emits text_delta@0, NOT a bare ping", async () => {
    const { stream, written } = stubSseStream()
    // Provider mode (function pingFrame) + NO injectAnchor: the tick goes straight to emitKeepalive, so the
    // frame it picks is driven purely by the open-block tracker — isolating the single-slot-vs-stack behavior.
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: makeAnthropicKeepaliveFrame } })

    // Anchor@0 (text) is opened and STAYS open (never stopped) — the buffered keepalive anchor.
    await sink.write(anchorStartFrame(0) as ClientFrame)
    // A real block flushes at the remapped index 1 ABOVE the anchor, then closes.
    await sink.write(blockStart(1, "thinking"))
    await sink.write(blockStop(1))

    // Inter-block silence: the real block@1 is closed but the anchor@0 is still open beneath it.
    await clock.advance(15_000)

    // Single-slot code: openBlock was overwritten to {1,thinking} then cleared by stop@1 → undefined → BARE PING.
    // Block-stack code: the stack fell back to the anchor {0,text} → an empty text_delta@0.
    expect(written.at(-1)).toEqual(wire(anchorTextDelta0))
    expect(written.at(-1)).not.toEqual(BARE_PING)
    sink.close?.()
  })

  test("multiple real blocks open+close over the anchor → after each closes, the tick rides the anchor again", async () => {
    const { stream, written } = stubSseStream()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: makeAnthropicKeepaliveFrame } })

    await sink.write(anchorStartFrame(0) as ClientFrame) // anchor@0 open (bottom of stack)
    await sink.write(blockStart(1, "thinking"))
    await sink.write(blockStop(1)) // real@1 closed → stack falls back to anchor@0
    await clock.advance(15_000)
    expect(written.at(-1)).toEqual(wire(anchorTextDelta0))

    await sink.write(blockStart(2, "text"))
    await sink.write(blockStop(2)) // real@2 closed → stack falls back to anchor@0 again
    await clock.advance(15_000)
    expect(written.at(-1)).toEqual(wire(anchorTextDelta0))
    // No bare ping ever appeared across either inter-block gap.
    expect(written.some((w) => w.data === BARE_PING.data && w.event === BARE_PING.event)).toBe(false)
    sink.close?.()
  })

  test("while a real block@1 is OPEN, the tick rides the TOP of the stack (thinking_delta@1), not the anchor", async () => {
    const { stream, written } = stubSseStream()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: makeAnthropicKeepaliveFrame } })

    await sink.write(anchorStartFrame(0) as ClientFrame) // anchor@0 (bottom)
    await sink.write(blockStart(1, "thinking")) // real@1 (top) — still OPEN

    await clock.advance(15_000)
    // The topmost open block is the real thinking@1 → the keepalive is a thinking_delta@1 (continues the live block).
    const expected = makeAnthropicKeepaliveFrame({ index: 1, type: "thinking" })
    expect(written.at(-1)).toEqual(wire(expected))
    sink.close?.()
  })

  test("behaviour-neutral for a single real block (no anchor): delta while open, bare ping once closed", async () => {
    const { stream, written } = stubSseStream()
    const sink = makeSseSink(stream, { heartbeat: { intervalSec: 15, pingFrame: makeAnthropicKeepaliveFrame } })

    // Single real block, no anchor beneath — the pre-existing single-slot behavior must be reproduced verbatim.
    await sink.write(blockStart(0, "thinking"))
    await clock.advance(15_000)
    const openDelta = makeAnthropicKeepaliveFrame({ index: 0, type: "thinking" })
    expect(written.at(-1)).toEqual(wire(openDelta)) // rides the open block

    await sink.write(blockStop(0)) // block closed, stack empty → no open block
    await clock.advance(15_000)
    expect(written.at(-1)).toEqual(BARE_PING) // undefined open block → bare ping (unchanged)
    sink.close?.()
  })
})
