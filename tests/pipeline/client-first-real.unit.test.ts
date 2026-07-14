/**
 * Task 2.1 — client-sink fires onFirstRealContent once on the first non-synthetic
 * real content frame (spec 2026-07-14 §3.2). Sink stays format-agnostic: the test
 * passes a fake predicate + callback (handler binds isClientContentFrame + ctx).
 */
import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import { makeSseSink } from "~/lib/pipeline/client-sink"

/** Minimal fake SSEStreamingApi — writeSSE resolves immediately. */
function fakeStream() {
  return { writeSSE: () => Promise.resolve() } as unknown as Parameters<typeof makeSseSink>[0]
}

describe("client-sink onFirstRealContent", () => {
  test("fires exactly once, on the first non-synthetic real content frame", async () => {
    let fired = 0
    // predicate: a real content frame carries data with "delta"
    const isReal = (f: ClientFrame) => (f.data ?? "").includes("delta")
    const sink = makeSseSink(fakeStream(), {
      isRealContentFrame: isReal,
      onFirstRealContent: () => {
        fired++
      },
    })

    // synthetic keepalive (real-looking data but marked synthetic) — must NOT fire
    await sink.writeKeepalive!({ event: "content_block_delta", data: '{"delta":{}}' })
    expect(fired).toBe(0)

    // message_start (real but not content) — must NOT fire
    await sink.write({ event: "message_start", data: '{"type":"message_start"}' })
    expect(fired).toBe(0)

    // first real content — fires
    await sink.write({ event: "content_block_delta", data: '{"delta":{"text":"hi"}}' })
    expect(fired).toBe(1)

    // second real content — does NOT fire again
    await sink.write({ event: "content_block_delta", data: '{"delta":{"text":" there"}}' })
    expect(fired).toBe(1)
  })

  test("no predicate → never fires (opt-out safe)", async () => {
    let fired = 0
    const sink = makeSseSink(fakeStream(), { onFirstRealContent: () => fired++ })
    await sink.write({ event: "content_block_delta", data: '{"delta":{}}' })
    expect(fired).toBe(0)
  })
})
