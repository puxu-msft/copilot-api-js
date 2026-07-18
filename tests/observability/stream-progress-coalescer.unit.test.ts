import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { StreamProgressEvent } from "~/lib/observability/stream-progress-coalescer"

import { StreamProgressCoalescer } from "~/lib/observability/stream-progress-coalescer"

function event(id: string, bytesIn: number): StreamProgressEvent {
  return {
    kind: "request.stream_progress",
    ctx: { id, endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", state: "streaming", startTime: 1, queueWaitMs: 0 },
    bytesIn,
  }
}

describe("StreamProgressCoalescer", () => {
  test("delivers only the latest value per request and flushes a terminal request synchronously", () => {
    const delivered: Array<StreamProgressEvent> = []
    const coalescer = new StreamProgressCoalescer({ intervalMs: 75, deliver: (item) => delivered.push(item) })
    for (const item of [event("a", 1), event("a", 2), event("b", 3)]) coalescer.push(item)

    coalescer.flush("a")
    expect(delivered.map((item) => [item.ctx.id, item.bytesIn])).toEqual([["a", 2]])
    coalescer.flush()
    expect(delivered.map((item) => [item.ctx.id, item.bytesIn])).toEqual([
      ["a", 2],
      ["b", 3],
    ])
    coalescer.destroy()
  })
})
