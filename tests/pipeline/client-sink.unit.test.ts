/**
 * Stage B B1 — ClientSink factory behavior (event-line, WS send, single-chain
 * serialization, reject-propagation-without-poisoning).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import {
  //
  makeArraySink,
  makeSseSink,
  makeWsSink,
} from "~/lib/pipeline/client-sink"

describe("makeArraySink", () => {
  test("collects written frames in order", async () => {
    const { sink, frames } = makeArraySink()
    await sink.write({ data: "a" })
    await sink.write({ event: "x", data: "b" })
    expect(frames).toEqual([{ data: "a" }, { event: "x", data: "b" }])
  })

  test("serializes interleaved writes through one chain (FIFO order preserved)", async () => {
    const { sink, frames } = makeArraySink()
    // Fire three writes without awaiting between them — they must land in call order.
    const p = [sink.write({ data: "1" }), sink.write({ data: "2" }), sink.write({ data: "3" })]
    await Promise.all(p)
    expect(frames.map((f) => f.data)).toEqual(["1", "2", "3"])
  })

  test("a rejecting write propagates to the caller but does NOT poison later writes", async () => {
    const { sink, frames } = makeArraySink({ rejectAtFrame: 1 })
    await sink.write({ data: "0" }) // ok
    await expect(sink.write({ data: "1" })).rejects.toThrow(/disconnected mid-write/)
    // Chain stays alive — a subsequent write still runs.
    await sink.write({ data: "2" })
    expect(frames.map((f) => f.data)).toEqual(["0", "2"])
  })
})

describe("makeSseSink", () => {
  function mockStream(): { stream: Parameters<typeof makeSseSink>[0]; writes: Array<unknown> } {
    const writes: Array<unknown> = []
    // Only `writeSSE` is exercised by the sink.
    const stream = { writeSSE: (msg: unknown) => (writes.push(msg), Promise.resolve()) } as unknown as Parameters<typeof makeSseSink>[0]
    return { stream, writes }
  }

  test("writes data + event line; omits event when undefined", async () => {
    const { stream, writes } = mockStream()
    const sink = makeSseSink(stream)
    await sink.write({ event: "message", data: "hi" })
    await sink.write({ data: "[DONE]" })
    expect(writes).toEqual([{ data: "hi", event: "message" }, { data: "[DONE]" }])
  })

  test("undefined data writes an empty string (never undefined)", async () => {
    const { stream, writes } = mockStream()
    await makeSseSink(stream).write({} as ClientFrame)
    expect(writes).toEqual([{ data: "" }])
  })
})

describe("makeWsSink", () => {
  test("sends the frame data string", async () => {
    const sent: Array<string> = []
    const ws = { send: (s: string) => void sent.push(s) } as unknown as Parameters<typeof makeWsSink>[0]
    const sink = makeWsSink(ws)
    await sink.write({ data: '{"type":"x"}' })
    await sink.write({}) // empty → ""
    expect(sent).toEqual(['{"type":"x"}', ""])
  })
})
