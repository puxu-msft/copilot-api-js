import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { readOrigin } from "~/lib/pipeline/hooks/origin"
import {
  //
  rawStream,
  sse,
  streamOf,
} from "~/lib/pipeline/hooks/toolkit"

async function collect<T>(iter: AsyncIterable<T>): Promise<Array<T>> {
  const out: Array<T> = []
  for await (const item of iter) out.push(item)
  return out
}

describe("sse", () => {
  test("builds a frame with event + JSON-serialized data", () => {
    const frame = sse("message_start", { type: "message_start" })

    expect(frame.event).toBe("message_start")
    expect(frame.data).toBe(JSON.stringify({ type: "message_start" }))
  })

  test("omits the event field when event is undefined", () => {
    const frame = sse(undefined, { type: "message" })

    expect(frame.event).toBeUndefined()
    expect(frame.data).toBe(JSON.stringify({ type: "message" }))
  })

  test("passes a string dataObj through verbatim (no double JSON-encoding)", () => {
    const frame = sse(undefined, "[DONE]")

    expect(frame.data).toBe("[DONE]")
  })
})

describe("rawStream", () => {
  test("iterates the given frames without any hook-origin tag", async () => {
    const frames = [sse("a", { x: 1 }), sse("b", { x: 2 })]
    const s = rawStream(frames)

    expect(await collect(s.frames)).toEqual(frames)
    expect(readOrigin(s)).toBeUndefined()
  })

  test("defaults headers to an empty Headers instance", () => {
    const s = rawStream([])

    expect(s.headers).toBeInstanceOf(Headers)
  })
})

describe("streamOf", () => {
  test("iterates the given frames", async () => {
    const frames = [sse("a", { x: 1 }), sse("b", { x: 2 })]
    const s = streamOf(frames)

    expect(await collect(s.frames)).toEqual(frames)
  })

  test("tags the stream hook-mock", () => {
    const s = streamOf([])

    expect(readOrigin(s)).toBe("hook-mock")
  })
})
