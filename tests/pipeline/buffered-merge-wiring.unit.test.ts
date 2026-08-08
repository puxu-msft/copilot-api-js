import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  BufferedFlushContext,
  ClientFrame,
  RunBufferedOpts,
} from "~/lib/pipeline/types"

import { makeArraySink } from "~/lib/pipeline/client-sink"
import { runResponseBufferedSink } from "~/lib/pipeline/driver"

import { makeBufferedHarness } from "./helpers/buffered-harness"

function d(type: string): ClientFrame {
  return { event: type, data: JSON.stringify({ type }) }
}

describe("transformBufferedFlush wiring (candidate-hosted seam, spec §4 重接地)", () => {
  test("transformFlush is called at every flush with the correct cause; its return value is what the sink receives", async () => {
    const flushCalls: Array<{ frames: ReadonlyArray<ClientFrame>; ctx: BufferedFlushContext }> = []
    const transformBufferedFlush: RunBufferedOpts["transformBufferedFlush"] = (frames, ctx) => {
      flushCalls.push({ frames, ctx })
      return frames.filter((f) => f.event !== "response.output_text.delta") // drop deltas, spy probe
    }
    const frames = [d("response.created"), d("response.output_text.delta"), d("response.output_text.delta"), d("response.completed")]
    const h = makeBufferedHarness(frames, { sawMessageStop: true })
    const { sink, frames: written } = makeArraySink()

    const outcome = await runResponseBufferedSink(h.deps, h.upstream, h.env, sink, {
      ...h.opts,
      sawMessageStop: () => true,
      transformBufferedFlush,
    })

    expect(outcome.kind).toBe("complete")
    expect(flushCalls.length).toBeGreaterThan(0)
    const lastFlush = flushCalls.at(-1)
    expect(lastFlush).toBeDefined()
    expect(lastFlush?.ctx.cause).toBe("terminal-drain")
    // the sink must have received the FILTERED set (transformFlush's return value), not the raw buffer
    expect(written.some((f) => f.event === "response.output_text.delta")).toBe(false)
    expect(written.map((f) => f.event)).toEqual(["response.created", "response.completed"])
  })

  test("R1: transformBufferedFlush omitted → every flush writes the raw buffer verbatim (byte-identical to pre-seam behavior)", async () => {
    const frames = [d("response.created"), d("response.output_text.delta"), d("response.completed")]
    const h = makeBufferedHarness(frames, { sawMessageStop: true })
    const { sink, frames: written } = makeArraySink()
    const outcome = await runResponseBufferedSink(h.deps, h.upstream, h.env, sink, { ...h.opts, sawMessageStop: () => true }) // no transformBufferedFlush
    expect(outcome.kind).toBe("complete")
    expect(written.map((f) => f.event)).toEqual(["response.created", "response.output_text.delta", "response.completed"])
  })
})
