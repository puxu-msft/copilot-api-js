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

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  processAnthropicStream,
  type ProcessedAnthropicEvent,
} from "~/lib/anthropic/stream"
import { createAnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import {
  //
  state,
  setStateForTests,
} from "~/lib/state"
import {
  //
  STREAM_ABORTED,
  StreamClientAbortError,
  StreamIdleTimeoutError,
  combineAbortSignals,
  raceIteratorNext,
} from "~/lib/stream"

// ============================================================================
// Helpers
// ============================================================================

/** Create an async iterable from an array of SSE messages, with optional per-item delay */
async function* fakeSSEStream(messages: Array<ServerSentEventMessage>, opts?: { delayMs?: number }): AsyncGenerator<ServerSentEventMessage> {
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

/** Sentinel for the time-free "this promise has not settled yet" probe (see the abort-signal case). */
const STILL_PENDING = Symbol("still-pending")

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

    const racePromise = raceIteratorNext(iter.next(), {
      idleTimeoutMs: 0,
      abortSignal: controller.signal,
    })

    // Causal half, and the part the old `elapsed < 200` never supplied: the race has not settled
    // within one microtask tick, and the abort is issued on the very next line, so that tick is the
    // whole window. The iterator never resolves and the idle timeout is off, so anything settling in
    // it would not have been caused by the abort. (Strictly: a path needing two or more microtask
    // ticks to settle would slip past this probe — the claim is one tick, not "never".) Reads no
    // clock, so contention cannot move it.
    expect(await Promise.race([racePromise, Promise.resolve(STILL_PENDING)])).toBe(STILL_PENDING)

    const abortedAt = Date.now()
    controller.abort()
    const result = await racePromise

    expect(result).toBe(STREAM_ABORTED)
    // Outlier tripwire only — the causal proof is above. This still catches a POLLED abort path (one
    // that returns STREAM_ABORTED eventually rather than on the event), which the assertion above
    // cannot: any poll interval of ~1s or more trips it. A never-wired abort path is caught by the
    // per-test budget instead, since the race would simply never settle.
    //
    // Why 1s is generous rather than tight: measured from the abort itself, this window contains NO
    // timer at all — synchronous listener dispatch plus one microtask — so contention has almost
    // nothing to stretch. The old form started its clock before a `setTimeout(..., 50)` and allowed
    // 200ms total, leaving 150ms to cover that timer's scheduling; that framing is what made it
    // fragile, not the bound being small.
    expect(Date.now() - abortedAt).toBeLessThan(1_000)
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
    setStateForTests({ streamIdleTimeout: savedIdleTimeout })
  })

  test("yields all events from a normal stream", async () => {
    setStateForTests({ streamIdleTimeout: 0 })

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
      makeSseMsg(JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), "content_block_start"),
      makeSseMsg(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }), "content_block_delta"),
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
    setStateForTests({ streamIdleTimeout: 0 })

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
    setStateForTests({ streamIdleTimeout: 0 })

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
    setStateForTests({ streamIdleTimeout: 0 })

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
    setStateForTests({ streamIdleTimeout: 0.05 })

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

  test("client abort (not shutdown) throws StreamClientAbortError so the caller settles it as aborted", async () => {
    setStateForTests({ streamIdleTimeout: 0 })

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
    const clientAbort = new AbortController()
    const events: Array<ProcessedAnthropicEvent> = []

    let thrown: unknown
    try {
      for await (const event of processAnthropicStream(stream, acc, clientAbort.signal)) {
        events.push(event)
        if (events.length === 1) {
          setTimeout(() => clientAbort.abort(), 50)
        }
      }
    } catch (error) {
      thrown = error
    } finally {
      unstall()
    }

    // Client disconnect → throw StreamClientAbortError (distinct from shutdown),
    // so the handler records the request as `aborted` rather than completed (Bug 2).
    expect(events).toHaveLength(1)
    expect(thrown).toBeInstanceOf(StreamClientAbortError)
  })

  // ── Upstream iterator cleanup (best-effort, fire-and-forget) ──────────────

  /**
   * Stalling upstream that records `return()` calls. `next()` yields the initial
   * messages then stalls forever; `return()` resolves per the `returnHangs` flag.
   */
  function instrumentedStallingStream(
    initialMessages: Array<ServerSentEventMessage>,
    opts?: { returnHangs?: boolean },
  ): { stream: AsyncIterable<ServerSentEventMessage>; returnCalls: () => number } {
    let returnCalls = 0
    let index = 0
    const stream: AsyncIterable<ServerSentEventMessage> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<ServerSentEventMessage>> {
            if (index < initialMessages.length) {
              return Promise.resolve({ value: initialMessages[index++], done: false })
            }
            return new Promise<IteratorResult<ServerSentEventMessage>>(() => {
              // stall forever
            })
          },
          return(): Promise<IteratorResult<ServerSentEventMessage>> {
            returnCalls += 1
            if (opts?.returnHangs) {
              return new Promise<IteratorResult<ServerSentEventMessage>>(() => {
                // return() queued behind a stalled next() — never resolves
              })
            }
            return Promise.resolve({ value: undefined as unknown as ServerSentEventMessage, done: true })
          },
        }
      },
    }
    return { stream, returnCalls: () => returnCalls }
  }

  const messageStartMsg = makeSseMsg(
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
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
  )

  test("closes the upstream iterator (best-effort) when the client aborts", async () => {
    setStateForTests({ streamIdleTimeout: 0 })
    const { stream, returnCalls } = instrumentedStallingStream([messageStartMsg])
    const acc = createAnthropicStreamAccumulator()
    const client = new AbortController()
    const events: Array<ProcessedAnthropicEvent> = []

    let thrown: unknown
    try {
      for await (const ev of processAnthropicStream(stream, acc, client.signal)) {
        events.push(ev)
        if (events.length === 1) setTimeout(() => client.abort(), 30)
      }
    } catch (error) {
      thrown = error
    }
    await new Promise((r) => setTimeout(r, 20))

    expect(thrown).toBeInstanceOf(StreamClientAbortError)
    expect(returnCalls()).toBe(1)
  })

  test("a non-resolving upstream return() does NOT block the handler (fire-and-forget)", async () => {
    setStateForTests({ streamIdleTimeout: 0 })
    const { stream, returnCalls } = instrumentedStallingStream([messageStartMsg], { returnHangs: true })
    const acc = createAnthropicStreamAccumulator()
    const client = new AbortController()
    const events: Array<ProcessedAnthropicEvent> = []

    let thrown: unknown
    const drain = (async () => {
      try {
        for await (const ev of processAnthropicStream(stream, acc, client.signal)) {
          events.push(ev)
          if (events.length === 1) setTimeout(() => client.abort(), 30)
        }
      } catch (error) {
        thrown = error
      }
    })()

    const outcome = await Promise.race([drain.then(() => "settled" as const), new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 300))])

    expect(outcome).toBe("settled")
    expect(thrown).toBeInstanceOf(StreamClientAbortError)
    expect(returnCalls()).toBe(1)
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
    setStateForTests({ streamIdleTimeout: savedIdleTimeout })
  })

  /**
   * This test reproduces the exact scenario from the bug report:
   * - Stream receives some initial events (2ev, 469B as in the log)
   * - Upstream stops sending data but connection stays alive
   * - Without the fix, `await iterator.next()` blocks forever
   * - With the fix, an external abort signal can break the wait
   *
   * Request-owned cancellation uses the same underlying iterator race, so this
   * test exercises `raceIteratorNext` directly with an abort signal.
   */
  test("raceIteratorNext resolves STREAM_ABORTED when signal fires during stall", async () => {
    const controller = new AbortController()
    const iter = stalledIterator<ServerSentEventMessage>()

    const racePromise = raceIteratorNext(iter.next(), {
      idleTimeoutMs: 0, // No idle timeout (default config)
      abortSignal: controller.signal,
    })

    // Nothing settles this on its own — not immediately, and not across a real stall. The second
    // probe is what the old `expect(elapsed).toBeGreaterThanOrEqual(40)` was inferring indirectly
    // ("it must have waited for the setTimeout"), asserted directly instead. Both are one-sided:
    // contention can only make the stall longer, which only makes "still pending" more true.
    expect(await Promise.race([racePromise, Promise.resolve(STILL_PENDING)])).toBe(STILL_PENDING)
    await new Promise((resolve) => setTimeout(resolve, 50)) // the same 50ms stall as before
    expect(await Promise.race([racePromise, Promise.resolve(STILL_PENDING)])).toBe(STILL_PENDING)

    const abortedAt = Date.now()
    controller.abort()
    const result = await racePromise

    expect(result).toBe(STREAM_ABORTED)
    // Must complete promptly after abort, not hang until TCP timeout. Outlier tripwire only — see
    // the abort-signal case above for why 1s is generous here: measured from the abort itself, this
    // window holds no timer, just listener dispatch and a microtask. The previous form started its
    // clock before the 50ms stall and capped the total at 200ms, so the stall's own scheduling ate
    // most of the margin.
    expect(Date.now() - abortedAt).toBeLessThan(1_000)
  })

  test("processAnthropicStream breaks out when idle timeout fires on stalled upstream", async () => {
    // This simulates the bug scenario with idle timeout as the safety net
    setStateForTests({ streamIdleTimeout: 0.05 })

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
