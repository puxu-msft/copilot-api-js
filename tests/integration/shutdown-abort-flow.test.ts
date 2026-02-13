/**
 * Integration tests for abort signal → streaming handler flow.
 * Tests the pattern used by handlers to gracefully stop streaming on shutdown.
 */

import { describe, expect, test } from "bun:test"

import { createFakeStream } from "../helpers/fake-stream"

describe("abort signal + streaming integration", () => {
  test("stream yields all chunks when not aborted", async () => {
    const chunks = [1, 2, 3, 4, 5]
    const received: number[] = []

    for await (const chunk of createFakeStream(chunks)) {
      received.push(chunk)
    }

    expect(received).toEqual([1, 2, 3, 4, 5])
  })

  test("stream stops yielding when signal is aborted before iteration", async () => {
    const controller = new AbortController()
    controller.abort() // Abort before starting

    const received: number[] = []
    for await (const chunk of createFakeStream([1, 2, 3], { signal: controller.signal })) {
      received.push(chunk)
    }

    expect(received).toEqual([])
  })

  test("stream stops yielding after abort mid-iteration", async () => {
    const controller = new AbortController()
    const chunks = [1, 2, 3, 4, 5]
    const received: number[] = []

    for await (const chunk of createFakeStream(chunks, { delayMs: 20, signal: controller.signal })) {
      received.push(chunk)
      if (received.length === 2) controller.abort()
    }

    // Should have received at most 2 chunks (abort fires after 2nd)
    expect(received.length).toBeLessThanOrEqual(2)
    expect(received[0]).toBe(1)
    expect(received[1]).toBe(2)
  })

  test("no error thrown on abort — stream ends gracefully", async () => {
    const controller = new AbortController()

    // Abort after first chunk
    let error: Error | null = null
    try {
      for await (const _chunk of createFakeStream([1, 2, 3], { delayMs: 10, signal: controller.signal })) {
        controller.abort()
      }
    } catch (e) {
      error = e as Error
    }

    expect(error).toBeNull()
  })

  test("handler abort pattern: break on signal.aborted in for-await", async () => {
    const controller = new AbortController()
    const events = [
      { type: "content_block_delta", data: "chunk1" },
      { type: "content_block_delta", data: "chunk2" },
      { type: "content_block_delta", data: "chunk3" },
      { type: "content_block_delta", data: "chunk4" },
    ]
    const processed: string[] = []

    // Simulate the pattern used in actual handlers:
    // for await (const event of stream) {
    //   if (getShutdownSignal()?.aborted) break
    //   processEvent(event)
    // }
    for await (const event of createFakeStream(events, { delayMs: 10 })) {
      // Check abort signal (simulating handler pattern)
      if (controller.signal.aborted) break
      processed.push(event.data)
      // Abort after processing first chunk
      if (processed.length === 1) controller.abort()
    }

    // First chunk processed, then abort detected on next iteration
    expect(processed).toEqual(["chunk1"])
  })

  test("accumulator data preserved after abort-induced break", async () => {
    const controller = new AbortController()
    const events = ["Hello ", "world", "!", " More text"]
    let accumulated = ""

    for await (const chunk of createFakeStream(events, { delayMs: 10 })) {
      if (controller.signal.aborted) break
      accumulated += chunk
      if (accumulated.length >= 11) controller.abort() // Abort after "Hello world"
    }

    // Data accumulated before abort is preserved
    expect(accumulated).toContain("Hello ")
    expect(accumulated.length).toBeGreaterThan(0)
  })

  test("abort signal works with synchronous chunks (no delay)", async () => {
    const controller = new AbortController()
    const received: number[] = []

    for await (const chunk of createFakeStream([1, 2, 3, 4, 5])) {
      if (controller.signal.aborted) break
      received.push(chunk)
      if (received.length === 3) controller.abort()
    }

    expect(received).toEqual([1, 2, 3])
  })
})
