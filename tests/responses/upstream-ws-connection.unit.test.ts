import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type {
  //
  UpstreamWsConnection,
  WebSocketLike,
} from "~/lib/openai/upstream-ws-connection"

import {
  //
  cancellationAbortError,
  getCancellationCause,
} from "~/lib/error/cancellation-reason"
import {
  //
  createUpstreamWsManager,
  setUpstreamWsConnectionFactoryForTests,
} from "~/lib/openai/upstream-ws"
import {
  //
  createUpstreamWsConnection,
  isCapiWebSocketError,
} from "~/lib/openai/upstream-ws-connection"

class FakeSocket extends EventTarget implements WebSocketLike {
  readyState = 0
  readonly OPEN = 1
  readonly CONNECTING = 0
  readonly CLOSING = 2
  readonly CLOSED = 3
  sent: Array<string> = []
  closeCalls: Array<{ code?: number; reason?: string }> = []

  send(data: string): void {
    this.sent.push(data)
  }

  close(_code?: number, _reason?: string): void {
    this.closeCalls.push({ code: _code, reason: _reason })
    this.readyState = this.CLOSED
    this.dispatchEvent(new CloseEvent("close", { code: 1000, reason: "closed" }))
  }

  open(): void {
    this.readyState = this.OPEN
    this.dispatchEvent(new Event("open"))
  }

  emitMessage(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }))
  }
}

/** Mimics undici's WHATWG close-code validation: throws on any code that is
 *  neither 1000 nor within [3000,4999], exactly like the real client WebSocket. */
class StrictFakeSocket extends FakeSocket {
  override close(code?: number, reason?: string): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException("invalid code", "InvalidAccessError")
    }
    super.close(code, reason)
  }
}

class DelayedCloseSocket extends FakeSocket {
  override close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason })
    this.readyState = this.CLOSING
  }

  finishClose(): void {
    this.readyState = this.CLOSED
    this.dispatchEvent(new CloseEvent("close", { code: 1000, reason: "closed" }))
  }
}

describe("upstream websocket connection", () => {
  let socket: FakeSocket

  beforeEach(() => {
    socket = new FakeSocket()
  })

  test("connects, sends response.create, and records stateful marker on completion", async () => {
    const connection = createUpstreamWsConnection({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      createSocket: () => socket,
    })

    const connectPromise = connection.connect()
    socket.open()
    await connectPromise

    const events = connection.sendRequest({
      model: "gpt-5.2",
      input: "hello",
      stream: true,
    })

    socket.emitMessage({
      type: "response.created",
      sequence_number: 0,
      response: {
        id: "resp_1",
        object: "response",
        created_at: 1,
        status: "in_progress",
        model: "gpt-5.2",
        output: [],
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
      },
    })
    socket.emitMessage({
      type: "response.completed",
      sequence_number: 1,
      response: {
        id: "resp_2",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "gpt-5.2",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
      },
    })

    const received: Array<string> = []
    for await (const event of events) {
      received.push(event.type)
    }

    expect(JSON.parse(socket.sent[0])).toMatchObject({
      type: "response.create",
      model: "gpt-5.2",
      input: "hello",
    })
    expect(received).toEqual(["response.created", "response.completed"])
    expect(connection.statefulMarker).toBe("resp_2")
    expect(connection.isBusy).toBe(false)
  })

  test("reports closed before connect and after close", async () => {
    const connection = createUpstreamWsConnection({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      createSocket: () => socket,
    })

    expect(connection.isOpen).toBe(false)

    const connectPromise = connection.connect()
    socket.open()
    await connectPromise
    expect(connection.isOpen).toBe(true)

    connection.close()
    expect(connection.isOpen).toBe(false)
  })

  test("dispose stays pending until the socket close barrier removes the connection owner", async () => {
    const delayed = new DelayedCloseSocket()
    const connection = createUpstreamWsConnection({
      headers: {},
      model: "gpt-5.2",
      idleTimeoutMs: 0,
      createSocket: () => delayed,
    })
    const connecting = connection.connect()
    delayed.open()
    await connecting

    let disposed = false
    const barrier = connection.dispose("hedged loser").then(() => {
      disposed = true
    })
    await flushMicrotasks()

    expect(connection.isOpen).toBe(false)
    expect(disposed).toBe(false)
    delayed.finishClose()
    await barrier
    expect(disposed).toBe(true)
  })

  test("dispose during handshake rejects the connect and cannot leak a late-open socket", async () => {
    const delayed = new DelayedCloseSocket()
    const connection = createUpstreamWsConnection({
      headers: {},
      model: "gpt-5.2",
      idleTimeoutMs: 0,
      createSocket: () => delayed,
    })
    const connecting = connection.connect()
    let disposed = false
    const barrier = connection.dispose("hedged loser").then(() => {
      disposed = true
    })
    await flushMicrotasks()

    await expect(connecting).rejects.toThrow(/hedged loser/i)
    expect(disposed).toBe(false)
    // The open listener was detached synchronously; a late open cannot promote this socket.
    delayed.open()
    expect(connection.isOpen).toBe(false)
    expect(disposed).toBe(false)
    delayed.finishClose()
    await barrier
    expect(disposed).toBe(true)
    expect(connection.isOpen).toBe(false)
  })

  test("actively closes socket when handshake fails", async () => {
    const connection = createUpstreamWsConnection({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      createSocket: () => socket,
    })

    const connectPromise = connection.connect()
    socket.dispatchEvent(new Event("error"))

    try {
      await connectPromise
      throw new Error("Expected connect() to reject on handshake error")
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("Upstream WebSocket handshake failed")
    }
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "Handshake failed" }])
    expect(connection.isOpen).toBe(false)
  })

  test("closes with WHATWG-legal 1000 on handshake failure (strict socket does not throw)", () => {
    const socket = new StrictFakeSocket()
    const connection = createUpstreamWsConnection({
      headers: {},
      model: "gpt-5.5",
      createSocket: () => socket,
    })
    // connect() must run first so the handshake error listener is attached; the
    // rejection is expected (handshake fails) so we swallow it here.
    void connection.connect().catch(() => {})
    // Handshake error before open → active close. Must NOT throw, and must use 1000.
    expect(() => socket.dispatchEvent(new Event("error"))).not.toThrow()
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "Handshake failed" }])
  })

  test("normalizes nested CAPI error frames", async () => {
    const connection = createUpstreamWsConnection({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      createSocket: () => socket,
    })

    const connectPromise = connection.connect()
    socket.open()
    await connectPromise

    const iterator = connection
      .sendRequest({
        model: "gpt-5.2",
        input: "hello",
        stream: true,
      })
      [Symbol.asyncIterator]()

    socket.emitMessage({
      type: "error",
      error: { code: "rate_limited", message: "too fast" },
      sequence_number: 1,
    })

    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value).toEqual({
      type: "error",
      code: "rate_limited",
      message: "too fast",
      sequence_number: 1,
    })
  })

  test("detects nested websocket error payloads", () => {
    expect(
      isCapiWebSocketError({
        type: "error",
        error: { code: "rate_limited", message: "slow down" },
      }),
    ).toBe(true)
    expect(isCapiWebSocketError({ type: "error", code: "flat" })).toBe(false)
  })

  test("closes socket when a malformed frame is received", async () => {
    const connection = createUpstreamWsConnection({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      createSocket: () => socket,
    })

    const connectPromise = connection.connect()
    socket.open()
    await connectPromise

    const iterator = connection.sendRequest({ model: "gpt-5.2", input: "hello", stream: true })[Symbol.asyncIterator]()

    // Push a frame that is invalid JSON
    socket.dispatchEvent(new MessageEvent("message", { data: "not json" }))

    // The next() should reject (queue was failed)
    let caught: unknown
    try {
      await iterator.next()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    // Socket should have been closed defensively
    expect(socket.closeCalls.some((c) => c.reason === "Parse error")).toBe(true)
  })

  test("handleClose is idempotent across duplicate close events", async () => {
    const onClose = mock(() => {})
    const connection = createUpstreamWsConnection({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      createSocket: () => socket,
      onClose,
    })

    const connectPromise = connection.connect()
    socket.open()
    await connectPromise

    socket.close()
    // Re-dispatch close (simulating implementations that fire it twice)
    socket.dispatchEvent(new CloseEvent("close", { code: 1006, reason: "double" }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(connection.isOpen).toBe(false)
  })

  test("a throwing onClose does not escape handleClose (guarded)", async () => {
    const socket = new FakeSocket()
    let onCloseCalled = false
    const connection = createUpstreamWsConnection({
      headers: {},
      model: "gpt-5.5",
      createSocket: () => socket,
      onClose: () => {
        onCloseCalled = true
        throw new Error("onClose boom")
      },
    })
    void connection.connect().catch(() => {})
    socket.open()
    // Drive a close; handleClose calls opts.onClose which throws. Guarded → must
    // NOT propagate out of dispatchEvent (the async uncaughtException escape point).
    // (.not.toThrow() alone is weak — a throwing EventTarget listener escapes
    // asynchronously, not out of dispatchEvent; the faithful no-uncaughtException
    // proof is the Task 1.3 subprocess test. bun:test additionally attributes the
    // async escape to this test, so unwired it goes red — verified red→green.)
    expect(() => socket.dispatchEvent(new CloseEvent("close", { code: 1000, reason: "x" }))).not.toThrow()
    // Side-effect oracle: handleClose actually ran (onClose invoked) and the throw
    // was absorbed by the guard, leaving the connection cleanly torn down.
    expect(onCloseCalled).toBe(true)
    expect(connection.isOpen).toBe(false)
  })

  test("a throwing onClose cannot wedge the dispose barrier", async () => {
    const delayed = new DelayedCloseSocket()
    const connection = createUpstreamWsConnection({
      headers: {},
      model: "gpt-5.5",
      createSocket: () => delayed,
      onClose: () => {
        throw new Error("onClose boom")
      },
    })
    const connecting = connection.connect()
    delayed.open()
    await connecting

    let settled = false
    const disposal = connection.dispose("test disposal").then(() => {
      settled = true
    })
    await flushMicrotasks()
    expect(settled).toBe(false)
    delayed.finishClose()

    await expect(disposal).resolves.toBeUndefined()
    expect(settled).toBe(true)
  })

  test("closes socket when send throws synchronously", async () => {
    const connection = createUpstreamWsConnection({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      createSocket: () => socket,
    })

    const connectPromise = connection.connect()
    socket.open()
    await connectPromise

    // Patch send to throw
    socket.send = () => {
      throw new Error("send failed")
    }

    const iterator = connection.sendRequest({ model: "gpt-5.2", input: "hello", stream: true })[Symbol.asyncIterator]()

    let caught: unknown
    try {
      await iterator.next()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(socket.closeCalls.some((c) => c.reason === "Send failed")).toBe(true)
  })

  test("close() before handshake completes still fires onClose (M5 placeholder cleanup)", () => {
    const onClose = mock(() => {})
    const connection = createUpstreamWsConnection({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      createSocket: () => socket,
      onClose,
    })

    // Close before connect() — no socket exists yet but the manager-side
    // placeholder must still be released.
    connection.close()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(connection.isOpen).toBe(false)
  })

  test("close() during in-flight handshake fires onClose exactly once", () => {
    const onClose = mock(() => {})
    const connection = createUpstreamWsConnection({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      createSocket: () => socket,
      onClose,
    })

    // Start connect (handshake pending), then close before open fires.
    void connection.connect().catch(() => {})
    connection.close()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(connection.isOpen).toBe(false)
  })

  test("concurrent connect() calls share the same in-flight handshake promise", async () => {
    const connection = createUpstreamWsConnection({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      createSocket: () => socket,
    })

    // Two callers race connect(); both must resolve to the same handshake
    // outcome instead of one throwing "already connecting".
    const p1 = connection.connect()
    const p2 = connection.connect()
    socket.open()
    await p1
    await p2
    expect(connection.isOpen).toBe(true)
  })

  test("first caller abort does NOT propagate to second caller (per-caller abort isolation)", async () => {
    const connection = createUpstreamWsConnection({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      createSocket: () => socket,
    })

    const ac1 = new AbortController()
    const ac2 = new AbortController()
    const p1 = connection.connect({ signal: ac1.signal })
    const p2 = connection.connect({ signal: ac2.signal })

    // First caller aborts — must reject p1 only; underlying handshake continues
    // for p2.
    ac1.abort()
    let p1Error: unknown
    try {
      await p1
    } catch (error) {
      p1Error = error
    }
    expect(p1Error).toBeInstanceOf(Error)
    expect((p1Error as Error).message).toBe("Upstream WebSocket connection aborted")

    // Handshake still completes — p2 must resolve.
    socket.open()
    await p2
    expect(connection.isOpen).toBe(true)
  })

  test("handshake abort keeps its own message AND chains the canceller's reason as `cause`", async () => {
    // This layer's message says WHERE it died, which the generic reason does not — so it is
    // kept. But replacing the reason ENTIRELY (what this used to do) erases WHICH party
    // cancelled: this handshake rides the same composite signal as the h2 path (client /
    // reaper / hard deadline / dispatch / shutdown), and the boundary then has to guess.
    // Chaining keeps both, because every provenance reader walks the cause chain.
    const connection = createUpstreamWsConnection({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      createSocket: () => socket,
    })

    const reason = cancellationAbortError("request-deadline", "request_deadline")
    const ac = new AbortController()
    const connecting = connection.connect({ signal: ac.signal })
    ac.abort(reason)

    const error = await connecting.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect((error as Error).message).toBe("Upstream WebSocket connection aborted")
    expect((error as Error).cause).toBe(reason)
    expect(getCancellationCause(error)).toBe("request-deadline")
  })

  test("idle socket error marks connection unusable and closes the socket", async () => {
    const connection = createUpstreamWsConnection({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      createSocket: () => socket,
    })

    const connectPromise = connection.connect()
    socket.open()
    await connectPromise
    expect(connection.isOpen).toBe(true)

    // Fire an error event while idle (no request in flight).
    socket.dispatchEvent(new Event("error"))

    // isOpen must flip false synchronously — pool reuse lookups in the same
    // tick must not hand out a poisoned connection waiting for its close event.
    expect(connection.isOpen).toBe(false)
    expect(socket.closeCalls.some((c) => c.reason === "Socket error")).toBe(true)
  })

  test("parse error mid-stream synchronously marks connection unusable", async () => {
    const connection = createUpstreamWsConnection({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      createSocket: () => socket,
    })

    const connectPromise = connection.connect()
    socket.open()
    await connectPromise

    const iterator = connection.sendRequest({ model: "gpt-5.2", input: "hello", stream: true })[Symbol.asyncIterator]()

    // Push an invalid JSON frame — handleMessage's parse throws.
    socket.dispatchEvent(new MessageEvent("message", { data: "{not json" }))

    // The iterator should reject.
    let caught: unknown
    try {
      await iterator.next()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    // And isOpen flips false synchronously so reuse can't pick it.
    expect(connection.isOpen).toBe(false)
    expect(socket.closeCalls.some((c) => c.reason === "Parse error")).toBe(true)
  })

  // ── L1 contract guard ────────────────────────────────────────────────────
  // Drives EACH of the 6 upstream-WS lifecycle close paths over a StrictFakeSocket
  // (which throws DOMException on any WHATWG-forbidden close code, mimicking undici's
  // real client WebSocket) and asserts, per path, that (a) driving it never throws and
  // (b) every recorded closeCall.code === 1000. This is the guard that would have caught
  // the original close(1001) bug AND catches a layer-2 regression (removing the try/catch
  // in closeUpstreamWs): with a forbidden code the strict socket throws, either surfacing
  // through the .not.toThrow() assertion or leaving closeCalls empty so the code===1000
  // assertion fails. Each path uses its own fresh socket+connection so the paths are
  // exercised in genuine isolation, not smeared into one shared lifecycle.
  describe("L1 guard: no lifecycle close path uses a WHATWG-forbidden code", () => {
    const makeStrict = (overrides?: Partial<Parameters<typeof createUpstreamWsConnection>[0]>) => {
      const strict = new StrictFakeSocket()
      const connection = createUpstreamWsConnection({
        headers: { authorization: "Bearer test" },
        model: "gpt-5.2",
        createSocket: () => strict,
        ...overrides,
      })
      return { strict, connection }
    }

    /** Every recorded close on a strict socket must be WHATWG-legal 1000, and at
     *  least one close must have fired for the named reason (guards against a
     *  vacuous pass where the path never closed at all). */
    const assertGuard = (strict: StrictFakeSocket, reason: string) => {
      expect(strict.closeCalls.length).toBeGreaterThanOrEqual(1)
      expect(strict.closeCalls.every((c) => c.code === 1000)).toBe(true)
      expect(strict.closeCalls.some((c) => c.reason === reason)).toBe(true)
    }

    test("Handshake failed", () => {
      const { strict, connection } = makeStrict({ headers: {}, model: "gpt-5.5" })
      // connect() attaches the handshake error listener; rejection is expected.
      void connection.connect().catch(() => {})
      // Handshake error before open → active close. Must NOT throw, must use 1000.
      expect(() => strict.dispatchEvent(new Event("error"))).not.toThrow()
      assertGuard(strict, "Handshake failed")
    })

    test("Going away (connection.close)", async () => {
      const { strict, connection } = makeStrict()
      const connectPromise = connection.connect()
      strict.open()
      await connectPromise
      expect(() => connection.close()).not.toThrow()
      assertGuard(strict, "Going away")
    })

    test("Socket error (idle)", async () => {
      const { strict, connection } = makeStrict()
      const connectPromise = connection.connect()
      strict.open()
      await connectPromise
      // Error event while idle → markUnusable + active close.
      expect(() => strict.dispatchEvent(new Event("error"))).not.toThrow()
      assertGuard(strict, "Socket error")
    })

    test("Parse error (mid-stream)", async () => {
      const { strict, connection } = makeStrict()
      const connectPromise = connection.connect()
      strict.open()
      await connectPromise
      const iterator = connection.sendRequest({ model: "gpt-5.2", input: "hello", stream: true })[Symbol.asyncIterator]()
      // Malformed JSON → handleMessage parse throws → defensive close. The close
      // happens synchronously inside dispatchEvent, so wrap it in not.toThrow().
      expect(() => strict.dispatchEvent(new MessageEvent("message", { data: "{not json" }))).not.toThrow()
      // Drain the now-failed iterator so its rejection is observed.
      await iterator.next().then(
        () => {},
        () => {},
      )
      assertGuard(strict, "Parse error")
    })

    test("Send failed", async () => {
      const { strict, connection } = makeStrict()
      const connectPromise = connection.connect()
      strict.open()
      await connectPromise
      strict.send = () => {
        throw new Error("send failed")
      }
      // sendRequest catches the send throw internally and closes defensively; it
      // must not itself throw, and the close must use 1000.
      let iterator: AsyncIterator<unknown> | undefined
      expect(() => {
        iterator = connection.sendRequest({ model: "gpt-5.2", input: "hello", stream: true })[Symbol.asyncIterator]()
      }).not.toThrow()
      await iterator?.next().then(
        () => {},
        () => {},
      )
      assertGuard(strict, "Send failed")
    })

    test("Idle timeout", async () => {
      // A short idle timeout lets the scheduled idle-close timer fire after the
      // handshake. The close runs inside a setTimeout callback, so it can't be
      // wrapped in not.toThrow() — but a forbidden code would make StrictFakeSocket
      // throw before recording, leaving closeCalls empty and failing assertGuard.
      const { strict, connection } = makeStrict({ idleTimeoutMs: 1 })
      const connectPromise = connection.connect()
      strict.open()
      await connectPromise
      await new Promise((resolve) => setTimeout(resolve, 30))
      assertGuard(strict, "Idle timeout")
    })
  })

  describe("rescheduleIdleTimeout / onIdle (P4 hot-reload)", () => {
    test("rescheduleIdleTimeout re-arms the idle timer with the new value (real timer, no fake clock)", async () => {
      const connection = createUpstreamWsConnection({
        headers: {},
        model: "gpt-5.2",
        idleTimeoutMs: 10_000, // long enough that it would NOT fire during this test if left unchanged
        createSocket: () => socket,
      })
      const connectPromise = connection.connect()
      socket.open()
      await connectPromise

      // Shrink the idle window to something the test can actually observe firing.
      connection.rescheduleIdleTimeout(20)

      await new Promise((r) => setTimeout(r, 60))
      expect(socket.closeCalls).toHaveLength(1)
      expect(socket.closeCalls[0]?.reason).toBe("Idle timeout")
    })

    test("rescheduleIdleTimeout while busy is a no-op until the request finishes (does not interrupt an in-flight request)", async () => {
      const connection = createUpstreamWsConnection({
        headers: {},
        model: "gpt-5.2",
        idleTimeoutMs: 10_000,
        createSocket: () => socket,
      })
      const connectPromise = connection.connect()
      socket.open()
      await connectPromise

      const events = connection.sendRequest({ model: "gpt-5.2", input: "hi", stream: true })
      connection.rescheduleIdleTimeout(20)

      // Busy connection must NOT be closed by the shrunk idle window.
      await new Promise((r) => setTimeout(r, 60))
      expect(socket.closeCalls).toHaveLength(0)

      socket.emitMessage({
        type: "response.completed",
        sequence_number: 0,
        response: { id: "resp_1", object: "response", created_at: 1, status: "completed", model: "gpt-5.2", output: [] },
      })
      for await (const _e of events) {
        /* drain */
      }

      // Now idle — the rescheduled (short) value takes effect on the NEXT
      // scheduleIdleClose() call (finishRequest), per Architecture.
      await new Promise((r) => setTimeout(r, 60))
      expect(socket.closeCalls).toHaveLength(1)
    })

    test("rescheduleIdleTimeout computes the new deadline from idleSince, not from the reschedule call time (HIGH-6) — extending after a long idle period fires sooner than a fresh full window would", async () => {
      const connection = createUpstreamWsConnection({
        headers: {},
        model: "gpt-5.2",
        idleTimeoutMs: 10_000, // long enough that it would not fire on its own during this test
        createSocket: () => socket,
      })
      const connectPromise = connection.connect()
      socket.open()
      await connectPromise
      // idleSince is stamped when onOpen marks the connection idle, above. Let a
      // good chunk of that idle window elapse BEFORE rescheduling.
      await new Promise((r) => setTimeout(r, 80))

      // If this were "restart a fresh window from now" (the bug this test would
      // catch), the connection would close ~100ms after THIS call. Idle-since
      // based, it closes ~20ms after this call — 80ms of the 100ms window had
      // already elapsed while idle before the reschedule.
      connection.rescheduleIdleTimeout(100)

      await new Promise((r) => setTimeout(r, 45))
      expect(socket.closeCalls).toHaveLength(1)
      expect(socket.closeCalls[0]?.reason).toBe("Idle timeout")
    })

    test("rescheduleIdleTimeout closes immediately when the new deadline (based on idleSince) has already passed", async () => {
      const connection = createUpstreamWsConnection({
        headers: {},
        model: "gpt-5.2",
        idleTimeoutMs: 10_000,
        createSocket: () => socket,
      })
      const connectPromise = connection.connect()
      socket.open()
      await connectPromise
      await new Promise((r) => setTimeout(r, 80)) // idle for 80ms already

      // The new window (30ms) is already shorter than the 80ms that has elapsed
      // since idleSince — the deadline is already in the past, so this must
      // close essentially immediately (Math.max(0, deadline - now) === 0), NOT
      // wait a further 30ms counted from this call.
      connection.rescheduleIdleTimeout(30)

      await new Promise((r) => setTimeout(r, 15))
      expect(socket.closeCalls).toHaveLength(1)
    })

    test("onIdle fires every time the connection transitions (back) to idle — the HIGH-5 eviction hook", async () => {
      const onIdleCalls: Array<true> = []
      const connection = createUpstreamWsConnection({
        headers: {},
        model: "gpt-5.2",
        idleTimeoutMs: 10_000,
        createSocket: () => socket,
        onIdle: () => onIdleCalls.push(true),
      })
      const connectPromise = connection.connect()
      socket.open()
      await connectPromise
      // The initial onOpen->idle transition counts as one.
      expect(onIdleCalls).toHaveLength(1)

      const events = connection.sendRequest({ model: "gpt-5.2", input: "hi", stream: true })
      expect(onIdleCalls).toHaveLength(1) // unchanged while busy

      socket.emitMessage({
        type: "response.completed",
        sequence_number: 0,
        response: { id: "resp_1", object: "response", created_at: 1, status: "completed", model: "gpt-5.2", output: [] },
      })
      for await (const _e of events) {
        /* drain */
      }

      expect(onIdleCalls).toHaveLength(2) // finishRequest() transitioned back to idle
    })
  })
})

function responseCreated(id: string): Record<string, unknown> {
  return {
    type: "response.created",
    sequence_number: 0,
    response: {
      id,
      object: "response",
      created_at: 1,
      status: "in_progress",
      model: "gpt-5.2",
      output: [],
      usage: null,
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
    },
  }
}

function responseEventId(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("response" in input)) return undefined
  const response = input.response
  if (!response || typeof response !== "object" || !("id" in response)) return undefined
  return typeof response.id === "string" ? response.id : undefined
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
}

async function openConnection(connection: UpstreamWsConnection, socket: FakeSocket): Promise<void> {
  const connected = connection.connect()
  socket.open()
  await connected
}

describe("P0-T3 pending-first-event and stale-queue cleanup oracle", () => {
  test("oracle positive control: an abort not wired to sendRequest leaves first-event next pending", async () => {
    const socket = new FakeSocket()
    const connection = createUpstreamWsConnection({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      conversationId: "conv-cleanup",
      idleTimeoutMs: 0,
      createSocket: () => socket,
    })
    await openConnection(connection, socket)

    const ignoredAbort = new AbortController()
    const iterator = connection.sendRequest({ model: "gpt-5.2", input: "loser", stream: true })[Symbol.asyncIterator]()
    const pending = iterator.next()
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    ignoredAbort.abort()
    await flushMicrotasks()

    expect(settled).toBe(false)
    expect(connection.isBusy).toBe(true)

    connection.close()
    await pending.catch(() => {})
  })

  test("sendRequest abort wakes pending first event and quarantines the connection", async () => {
    const socket = new FakeSocket()
    const connection = createUpstreamWsConnection({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      conversationId: "conv-cleanup",
      idleTimeoutMs: 0,
      createSocket: () => socket,
    })
    await openConnection(connection, socket)

    const abort = new AbortController()
    const iterator = connection.sendRequest({ model: "gpt-5.2", input: "loser", stream: true }, { abortSignal: abort.signal })[Symbol.asyncIterator]()
    const pending = iterator.next()
    await flushMicrotasks()

    abort.abort()

    await expect(pending).rejects.toThrow("Upstream WebSocket request aborted")
    expect(connection.isBusy).toBe(false)
    expect(connection.isOpen).toBe(false)
    // Defensive cleanup — onAbort already closed the socket.
    connection.close()
  })

  test("a request abort keeps the WS message AND chains the canceller's reason as `cause`", async () => {
    // Same rule as the handshake: an already-sent request cancelled by the reaper / hard
    // deadline must arrive at the boundary carrying WHICH one it was, or the boundary
    // falls back to guessing — the failure this family of fixes exists to end.
    const socket = new FakeSocket()
    const connection = createUpstreamWsConnection({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      conversationId: "conv-cause-chain",
      idleTimeoutMs: 0,
      createSocket: () => socket,
    })
    await openConnection(connection, socket)

    const reason = cancellationAbortError("stale-reaper", "Request cancelled by the stale-request reaper")
    const abort = new AbortController()
    const iterator = connection.sendRequest({ model: "gpt-5.2", input: "x", stream: true }, { abortSignal: abort.signal })[Symbol.asyncIterator]()
    const pending = iterator.next()
    await flushMicrotasks()

    abort.abort(reason)

    const error = await pending.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect((error as Error).message).toBe("Upstream WebSocket request aborted")
    expect((error as Error).cause).toBe(reason)
    expect(getCancellationCause(error)).toBe("stale-reaper")
    connection.close()
  })

  test("oracle positive control: queue exposes the exact remote frame identity", async () => {
    const socket = new FakeSocket()
    const connection = createUpstreamWsConnection({
      headers: { authorization: "Bearer test" },
      model: "gpt-5.2",
      conversationId: "conv-cleanup",
      idleTimeoutMs: 0,
      createSocket: () => socket,
    })
    await openConnection(connection, socket)

    const iterator = connection.sendRequest({ model: "gpt-5.2", input: "probe", stream: true })[Symbol.asyncIterator]()
    const pending = iterator.next()
    socket.emitMessage(responseCreated("resp_oracle_control"))

    const observed = await pending
    expect(responseEventId(observed.value)).toBe("resp_oracle_control")
    connection.close()
  })

  test("P5 contract: aborting a loser quarantines its connection so late frames cannot poison the next same-conversation request", async () => {
    const sockets: Array<FakeSocket> = []
    setUpstreamWsConnectionFactoryForTests((opts) =>
      createUpstreamWsConnection({
        headers: opts.headers,
        model: opts.model,
        conversationId: opts.conversationId,
        onClose: opts.onClose,
        idleTimeoutMs: 0,
        createSocket: () => {
          const socket = new FakeSocket()
          sockets.push(socket)
          return socket
        },
      }),
    )
    const manager = createUpstreamWsManager()

    try {
      const loser = await manager.create({
        headers: { authorization: "Bearer test" },
        model: "gpt-5.2",
        conversationId: "conv-cleanup",
      })
      const loserConnect = loser.connect()
      sockets[0]?.open()
      await loserConnect

      const loserAbort = new AbortController()
      const loserIterator = loser.sendRequest({ model: "gpt-5.2", input: "loser", stream: true }, { abortSignal: loserAbort.signal })[Symbol.asyncIterator]()
      const loserPending = loserIterator.next()
      await flushMicrotasks()
      loserAbort.abort()
      await expect(loserPending).rejects.toThrow("Upstream WebSocket request aborted")

      const nextConnection =
        manager.findReusable({ conversationId: "conv-cleanup", model: "gpt-5.2" })
        ?? (await manager.create({
          headers: { authorization: "Bearer test" },
          model: "gpt-5.2",
          conversationId: "conv-cleanup",
        }))

      if (!nextConnection.isOpen) {
        const nextConnect = nextConnection.connect()
        sockets.at(-1)?.open()
        await nextConnect
      }

      const nextIterator = nextConnection.sendRequest({ model: "gpt-5.2", input: "winner", stream: true })[Symbol.asyncIterator]()
      const nextPending = nextIterator.next()

      // The cancelled loser's remote peer races a late frame against the new same-conversation request. P5 must have detached/closed the old owner, so only resp_new can enter the new request queue.
      sockets[0]?.emitMessage(responseCreated("resp_late_from_loser"))
      const nextSocket = nextConnection === loser ? sockets[0] : sockets.at(-1)
      nextSocket?.emitMessage(responseCreated("resp_new"))

      const observed = await nextPending
      expect(responseEventId(observed.value)).toBe("resp_new")
      expect(nextConnection).not.toBe(loser)
    } finally {
      manager.closeAll()
      setUpstreamWsConnectionFactoryForTests(null)
    }
  })
})
