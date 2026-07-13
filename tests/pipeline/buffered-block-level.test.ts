/**
 * L2 block-level buffered retry — P0 mechanism floor (behaviour-neutral).
 *
 * Task 1: the driver gains a `commitBoundaries` predicate + block-level commit skeleton.
 *   - `commitBoundaries` PROVIDED → flush the buffer at each block boundary (committing it
 *     live); a first-block-then-truncate degrades to the new `partial-degrade` terminal
 *     (NO retry — the committed block is already on the wire, un-retryable).
 *   - `commitBoundaries` UNDEFINED → terminal-only = byte-identical to the whole-response
 *     buffered path (R1 landing gate): the buffer commits once at the terminal frame.
 *   - M1 terminal dedup: when `commitBoundaries` is provided AND the terminal frame is itself
 *     a boundary, it flushes in-loop; the after-loop terminal block only classifies (no second
 *     flush) — the terminal frame reaches the client exactly once.
 *
 * See docs/plan/2026-07-11-block-level-buffered-retry/plan-0-mechanism-floor.md + the frozen
 * contract in that dir's README.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ClientFrame,
  RunBufferedOpts,
} from "~/lib/pipeline/types"

import { makeArraySink } from "~/lib/pipeline/client-sink"
import { runResponseBufferedSink } from "~/lib/pipeline/driver"

import { makeBufferedHarness } from "./helpers/buffered-harness"

/** A raw client frame carrying only `data` (the anthropic identity-render shape). */
function d(obj: Record<string, unknown>): ClientFrame {
  return { data: JSON.stringify(obj) } as ClientFrame
}

/** Boundary predicate: a frame whose parsed `type` is one of `types`. */
function boundaryOn(types: Array<string>): (f: ClientFrame) => boolean {
  return (f) => {
    try {
      return types.includes((JSON.parse(f.data ?? "{}") as { type?: string }).type ?? "")
    } catch {
      return false
    }
  }
}

function sinkTypes(frames: Array<ClientFrame>): Array<string> {
  return frames.map((fr) => {
    try {
      return (JSON.parse(fr.data ?? "{}") as { type?: string }).type ?? "?"
    } catch {
      return "?"
    }
  })
}

describe("block-level commit — P0 mechanism floor", () => {
  test("commitBoundaries → flush at each boundary; first-block-then-truncate → partial-degrade, no retry", async () => {
    const frames: Array<ClientFrame> = [
      d({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      d({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
      d({ type: "content_block_stop", index: 0 }), // boundary → commit block 0
      d({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
      // upstream truncates here (clean drain, NO message_stop) AFTER block 0 already committed
    ]
    const h = makeBufferedHarness(frames, { sawMessageStop: false })
    const { sink, frames: written } = makeArraySink()
    const resolves: Array<{ outcome: string; vendor: string; retries: number }> = []

    const outcome = await runResponseBufferedSink(h.deps, h.upstream, h.env, sink, {
      ...h.opts,
      commitBoundaries: boundaryOn(["content_block_stop"]),
      sawMessageStop: () => false,
      telemetryVendor: "anthropic",
      onBufferedResolve: (o, retries, meta) => resolves.push({ outcome: o, vendor: meta.vendor, retries }),
    } as RunBufferedOpts)

    expect(outcome.kind).toBe("stream-error")
    // committed block 0 → NOT "exhausted", NOT retried → the new degrade terminal.
    expect(resolves).toEqual([{ outcome: "partial-degrade", vendor: "anthropic", retries: 0 }])
    // block 0 (through its content_block_stop) was flushed live at the boundary.
    expect(sinkTypes(written)).toEqual(["content_block_start", "content_block_delta", "content_block_stop"])
    // the truncated block-1 partial (buffered, never boundary-closed) was NOT forwarded.
    expect(written.some((fr) => (fr.data ?? "").includes('"index":1'))).toBe(false)
    // no re-exchange — a committed-then-truncate is un-retryable.
    expect(h.sendCount()).toBe(0)
  })

  test("commitBoundaries undefined → behaviour identical to whole-response (R1)", async () => {
    const frames: Array<ClientFrame> = [
      d({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      d({ type: "content_block_stop", index: 0 }),
      d({ type: "message_stop" }),
    ]
    const h = makeBufferedHarness(frames, { sawMessageStop: true })
    const { sink, frames: written } = makeArraySink()

    const outcome = await runResponseBufferedSink(h.deps, h.upstream, h.env, sink, {
      ...h.opts,
      sawMessageStop: () => true,
      // no commitBoundaries → terminal-only whole-response commit
    } as RunBufferedOpts)

    expect(outcome.kind).toBe("complete")
    // all three frames flushed once, at the terminal (whole-buffer commit).
    expect(sinkTypes(written)).toEqual(["content_block_start", "content_block_stop", "message_stop"])
  })

  test("M1: commitBoundaries + terminal frame is a boundary → terminal flushed exactly once (no double)", async () => {
    const frames: Array<ClientFrame> = [
      d({ type: "message_start", message: { id: "m" } }),
      d({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      d({ type: "content_block_stop", index: 0 }),
      d({ type: "message_stop" }), // terminal AND a boundary → flushes in-loop, after-loop only classifies
    ]
    const h = makeBufferedHarness(frames, { sawMessageStop: true })
    const { sink, frames: written } = makeArraySink()
    const resolves: Array<string> = []

    const outcome = await runResponseBufferedSink(h.deps, h.upstream, h.env, sink, {
      ...h.opts,
      commitBoundaries: boundaryOn(["content_block_stop", "message_stop"]),
      sawMessageStop: () => true,
      telemetryVendor: "anthropic",
      onBufferedResolve: (o) => resolves.push(o),
    } as RunBufferedOpts)

    expect(outcome.kind).toBe("complete")
    // message_stop reaches the client exactly ONCE (not double-flushed by loop + after-loop).
    expect(written.filter((fr) => (fr.data ?? "").includes("message_stop"))).toHaveLength(1)
    expect(sinkTypes(written)).toEqual(["message_start", "content_block_start", "content_block_stop", "message_stop"])
    expect(resolves).toEqual(["success"])
  })
})
