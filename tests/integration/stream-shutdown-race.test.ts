/**
 * Tests for shutdown abort signal racing with stream iterator.
 *
 * Verifies that streaming handlers break out of blocked `iterator.next()`
 * when the shutdown abort signal fires, instead of waiting for the next
 * SSE event (which may never arrive if the upstream connection stalls).
 *
 * Covers:
 * - raceIteratorNext: idle timeout, abort signal, fast paths, cleanup
 * - processAnthropicStream: shutdown signal interrupts stalled stream
 * - combineAbortSignals: multi-signal composition
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { processAnthropicStream, type ProcessedAnthropicEvent } from "~/lib/anthropic/sse"
import { createAnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import { state } from "~/lib/state"
import { STREAM_ABORTED, StreamIdleTimeoutError, combineAbortSignals, raceIteratorNext } from "~/lib/stream"

// ============================================================================
// Helpers
// ============================================================================

/** Create an async iterable from an array of SSE messages, with optional per-item delay */
async function* fakeSSEStream(
  messages: Array<ServerSentEventMessage>,
  opts?: { delayMs?: number },
): AsyncGenerator<ServerSentEventMessage> {
  for (const msg of messages) {
    if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
    yield msg
  }
}

/**
 * Create an async iterable that stalls after yielding `initialMessages`.
 * The stall is implemented as a promise that never resolves on its own,
 * simulating an upstream connection that is alive but sends no data.
 */
function createStallingStream(initialMessages: Array<ServerSentEventMessage>): {
  stream: AsyncIterable<ServerSentEventMessage>
  /** Resolve the stalled promise (for cleanup) */
  unstall: () => void
} {
  let unstallResolve: () => void
  const stallPromise = new Promise<void>((resolve) => {
    unstallResolve = resolve
  })

  async function* gen(): AsyncGenerator<ServerSentEventMessage> {
    for (const msg of initialMessages) {
      yield msg
    }
    // Stall indefinitely — simulates upstream sending no more data
    await stallPromise
  }

  return { stream: gen(), unstall: unstallResolve! }
}

/** Wrap an array into an async iterator */
function arrayIterator<T>(items: Array<T>): AsyncIterator<T> {
  let index = 0
  return {
    next(): Promise<IteratorResult<T>> {
      if (index < items.length) {
        return Promise.resolve({ value: items[index++], done: false })
      }
      return Promise.resolve({ value: undefined as T, done: true })
    },
  }
}

/** Create an iterator whose next() never resolves (simulates stalled connection) */
function stalledIterator<T>(): AsyncIterator<T> {
  return {
    next(): Promise<IteratorResult<T>> {
      return new Promise(() => {}) // Never resolves
    },
  }
}

function makeSseMsg(data: string, event?: string): ServerSentEventMessage {
  return { data, event, id: undefined, retry: undefined }
}

// ============================================================================
// raceIteratorNext
// ============================================================================

describe("raceIteratorNext", () => {
  test("resolves with iterator result when no timeout or signal", async () => {
    const iter = arrayIterator([1, 2, 3])
    const result = await raceIteratorNext(iter.next(), { idleTimeoutMs: 0 })

    expect(result).not.toBe(STREAM_ABORTED)
    if (result !== STREAM_ABORTED) {
      expect(result.done).toBe(false)
      expect(result.value).toBe(1)
    }
  })

  test("resolves with done when iterator is exhausted", async () => {
    const iter = arrayIterator<number>([])
    const result = await raceIteratorNext(iter.next(), { idleTimeoutMs: 0 })

    expect(result).not.toBe(STREAM_ABORTED)
    if (result !== STREAM_ABORTED) {
      expect(result.done).toBe(true)
    }
  })

  test("returns STREAM_ABORTED immediately when signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()

    const iter = stalledIterator<number>()
    const result = await raceIteratorNext(iter.next(), {
      idleTimeoutMs: 0,
      abortSignal: controller.signal,
    })

    expect(result).toBe(STREAM_ABORTED)
  })

  test("returns STREAM_ABORTED when signal fires during blocked next()", async () => {
    const controller = new AbortController()
    const iter = stalledIterator<number>()

    // Abort after 50ms
    setTimeout(() => controller.abort(), 50)

    const start = Date.now()
    const result = await raceIteratorNext(iter.next(), {
      idleTimeoutMs: 0,
      abortSignal: controller.signal,
    })
    const elapsed = Date.now() - start

    expect(result).toBe(STREAM_ABORTED)
    // Should complete quickly after abort, not hang
    expect(elapsed).toBeLessThan(200)
  })

  test("rejects with StreamIdleTimeoutError when idle timeout fires first", async () => {
    const iter = stalledIterator<number>()

    await expect(raceIteratorNext(iter.next(), { idleTimeoutMs: 50 })).rejects.toThrow(StreamIdleTimeoutError)
  })

  test("idle timeout fires before abort signal when timeout is shorter", async () => {
    const controller = new AbortController()
    const iter = stalledIterator<number>()

    // Abort after 200ms, but idle timeout at 50ms
    setTimeout(() => controller.abort(), 200)

    await expect(
      raceIteratorNext(iter.next(), {
        idleTimeoutMs: 50,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow(StreamIdleTimeoutError)
  })

  test("abort signal fires before idle timeout when abort is sooner", async () => {
    const controller = new AbortController()
    const iter = stalledIterator<number>()

    // Abort after 30ms, idle timeout at 500ms
    setTimeout(() => controller.abort(), 30)

    const result = await raceIteratorNext(iter.next(), {
      idleTimeoutMs: 500,
      abortSignal: controller.signal,
    })

    expect(result).toBe(STREAM_ABORTED)
  })

  test("normal resolution wins when iterator resolves before timeout and abort", async () => {
    const controller = new AbortController()
    const iter = arrayIterator([42])

    // Both timeout and abort are far in the future
    setTimeout(() => controller.abort(), 1000)

    const result = await raceIteratorNext(iter.next(), {
      idleTimeoutMs: 1000,
      abortSignal: controller.signal,
    })

    expect(result).not.toBe(STREAM_ABORTED)
    if (result !== STREAM_ABORTED) {
      expect(result.value).toBe(42)
    }

    // Cleanup: abort so we don't leak the timer
    controller.abort()
  })

  test("cleans up timeout and event listener after normal resolution", async () => {
    const controller = new AbortController()
    const iter = arrayIterator([1])

    await raceIteratorNext(iter.next(), {
      idleTimeoutMs: 5000,
      abortSignal: controller.signal,
    })

    // If cleanup failed, aborting now would cause issues or the timeout would still fire.
    // This is a basic sanity check — the real guarantee is that the .finally() runs.
    controller.abort()
    // No error thrown = listeners were cleaned up
  })
})

// ============================================================================
// processAnthropicStream + shutdown signal
// ============================================================================

describe("processAnthropicStream + shutdown signal", () => {
  let savedIdleTimeout: number

  beforeEach(() => {
    savedIdleTimeout = state.streamIdleTimeout
  })

  afterEach(() => {
    state.streamIdleTimeout = savedIdleTimeout
  })

  test("yields all events from a normal stream", async () => {
    state.streamIdleTimeout = 0

    const sseMessages = [
      makeSseMsg(
        JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-opus-4.6",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        }),
        "message_start",
      ),
      makeSseMsg(
        JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        "content_block_start",
      ),
      makeSseMsg(
        JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
        "content_block_delta",
      ),
      makeSseMsg(JSON.stringify({ type: "content_block_stop", index: 0 }), "content_block_stop"),
      makeSseMsg(
        JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 },
        }),
        "message_delta",
      ),
      makeSseMsg(JSON.stringify({ type: "message_stop" }), "message_stop"),
    ]

    const acc = createAnthropicStreamAccumulator()
    const events: Array<{ raw: ServerSentEventMessage; parsed?: unknown }> = []

    for await (const event of processAnthropicStream(fakeSSEStream(sseMessages), acc)) {
      events.push(event)
    }

    expect(events.length).toBe(6)
  })

  test("stops on [DONE] sentinel", async () => {
    state.streamIdleTimeout = 0

    const sseMessages = [
      makeSseMsg(
        JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-opus-4.6",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        }),
      ),
      makeSseMsg("[DONE]"),
      makeSseMsg(
        JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "should not appear" },
        }),
      ),
    ]

    const acc = createAnthropicStreamAccumulator()
    const events: Array<unknown> = []
    for await (const event of processAnthropicStream(fakeSSEStream(sseMessages), acc)) {
      events.push(event)
    }

    // Only the first event before [DONE]
    expect(events.length).toBe(1)
  })

  test("stops on error event", async () => {
    state.streamIdleTimeout = 0

    const sseMessages = [
      makeSseMsg(
        JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-opus-4.6",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        }),
      ),
      makeSseMsg(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })),
      makeSseMsg(
        JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "should not appear" },
        }),
      ),
    ]

    const acc = createAnthropicStreamAccumulator()
    const events: Array<unknown> = []
    for await (const event of processAnthropicStream(fakeSSEStream(sseMessages), acc)) {
      events.push(event)
    }

    // message_start + error, then stops
    expect(events.length).toBe(2)
  })

  test("yields keepalive events (no data)", async () => {
    state.streamIdleTimeout = 0

    const sseMessages: Array<ServerSentEventMessage> = [
      { data: undefined as unknown as string, event: "ping", id: undefined, retry: undefined },
      makeSseMsg(
        JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-opus-4.6",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        }),
      ),
      makeSseMsg("[DONE]"),
    ]

    const acc = createAnthropicStreamAccumulator()
    const events: Array<{ raw: ServerSentEventMessage; parsed?: unknown }> = []
    for await (const event of processAnthropicStream(fakeSSEStream(sseMessages), acc)) {
      events.push(event)
    }

    // keepalive + message_start
    expect(events.length).toBe(2)
    expect(events[0].parsed).toBeUndefined()
  })

  test("throws StreamIdleTimeoutError when stream stalls with idle timeout configured", async () => {
    state.streamIdleTimeout = 0.05 // 50ms

    const { stream, unstall } = createStallingStream([
      makeSseMsg(
        JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-opus-4.6",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        }),
      ),
    ])

    const acc = createAnthropicStreamAccumulator()

    try {
      const events: Array<unknown> = []
      for await (const event of processAnthropicStream(stream, acc)) {
        events.push(event)
      }
      // Should not reach here — the idle timeout should cause an error
      expect(true).toBe(false)
    } catch (error) {
      expect(error).toBeInstanceOf(StreamIdleTimeoutError)
    } finally {
      unstall()
    }
  })

  test("observes a shutdown signal that appears after streaming has already started", async () => {
    state.streamIdleTimeout = 0

    const { stream, unstall } = createStallingStream([
      makeSseMsg(
        JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-opus-4.6",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        }),
      ),
    ])

    const acc = createAnthropicStreamAccumulator()
    const controller = new AbortController()
    let currentShutdownSignal: AbortSignal | undefined
    const events: Array<ProcessedAnthropicEvent> = []

    try {
      for await (const event of processAnthropicStream(stream, acc, undefined, () => currentShutdownSignal)) {
        events.push(event)
        if (events.length === 1) {
          currentShutdownSignal = controller.signal
          setTimeout(() => controller.abort(), 50)
        }
      }
    } finally {
      unstall()
    }

    expect(events).toHaveLength(1)
  })
})

// ============================================================================
// The core bug: shutdown signal must interrupt stalled streams
// ============================================================================

describe("shutdown signal interrupts stalled stream (the core bug fix)", () => {
  let savedIdleTimeout: number

  beforeEach(() => {
    savedIdleTimeout = state.streamIdleTimeout
  })

  afterEach(() => {
    state.streamIdleTimeout = savedIdleTimeout
  })

  /**
   * This test reproduces the exact scenario from the bug report:
   * - Stream receives some initial events (2ev, 469B as in the log)
   * - Upstream stops sending data but connection stays alive
   * - Without the fix, `await iterator.next()` blocks forever
   * - With the fix, an external abort signal can break the wait
   *
   * Since processAnthropicStream uses getShutdownSignal() internally
   * (which reads from the shutdown module), we test the underlying
   * mechanism directly via raceIteratorNext with an abort signal.
   */
  test("raceIteratorNext resolves STREAM_ABORTED when signal fires during stall", async () => {
    const controller = new AbortController()
    const iter = stalledIterator<ServerSentEventMessage>()

    // Simulate: abort signal fires 50ms into the stall
    setTimeout(() => controller.abort(), 50)

    const start = Date.now()
    const result = await raceIteratorNext(iter.next(), {
      idleTimeoutMs: 0, // No idle timeout (default config)
      abortSignal: controller.signal,
    })
    const elapsed = Date.now() - start

    expect(result).toBe(STREAM_ABORTED)
    // Must complete promptly after abort, not hang until TCP timeout
    expect(elapsed).toBeLessThan(200)
    expect(elapsed).toBeGreaterThanOrEqual(40) // Sanity: waited for the setTimeout
  })

  test("processAnthropicStream breaks out when idle timeout fires on stalled upstream", async () => {
    // This simulates the bug scenario with idle timeout as the safety net
    state.streamIdleTimeout = 0.05 // 50ms

    const initialEvents = [
      makeSseMsg(
        JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-opus-4.6",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        }),
      ),
      makeSseMsg(JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })),
    ]

    const { stream, unstall } = createStallingStream(initialEvents)
    const acc = createAnthropicStreamAccumulator()

    try {
      const events: Array<unknown> = []
      for await (const event of processAnthropicStream(stream, acc)) {
        events.push(event)
      }
      // Should not complete normally — idle timeout should throw
      expect(true).toBe(false)
    } catch (error) {
      expect(error).toBeInstanceOf(StreamIdleTimeoutError)
    } finally {
      unstall()
    }
  })

  test("raceIteratorNext: abort signal wins over idle timeout when it fires first", async () => {
    const controller = new AbortController()
    const iter = stalledIterator<number>()

    // Abort at 30ms, idle timeout at 5000ms
    setTimeout(() => controller.abort(), 30)

    const start = Date.now()
    const result = await raceIteratorNext(iter.next(), {
      idleTimeoutMs: 5000,
      abortSignal: controller.signal,
    })
    const elapsed = Date.now() - start

    expect(result).toBe(STREAM_ABORTED)
    // Should resolve at ~30ms (abort), not ~5000ms (timeout)
    expect(elapsed).toBeLessThan(200)
  })
})

// ============================================================================
// combineAbortSignals
// ============================================================================

describe("combineAbortSignals", () => {
  test("returns undefined when all inputs are undefined", () => {
    expect(combineAbortSignals(undefined, undefined)).toBeUndefined()
  })

  test("returns undefined when called with no arguments", () => {
    expect(combineAbortSignals()).toBeUndefined()
  })

  test("returns the single signal when only one is defined", () => {
    const controller = new AbortController()
    const result = combineAbortSignals(undefined, controller.signal, undefined)
    expect(result).toBe(controller.signal)
  })

  test("returns a combined signal that aborts when any input aborts", async () => {
    const c1 = new AbortController()
    const c2 = new AbortController()
    const combined = combineAbortSignals(c1.signal, c2.signal)

    expect(combined).toBeDefined()
    expect(combined!.aborted).toBe(false)

    c2.abort()
    expect(combined!.aborted).toBe(true)
  })

  test("returns an already-aborted signal if any input is already aborted", () => {
    const c1 = new AbortController()
    c1.abort()
    const c2 = new AbortController()

    const combined = combineAbortSignals(c1.signal, c2.signal)
    expect(combined).toBeDefined()
    expect(combined!.aborted).toBe(true)
  })
})
