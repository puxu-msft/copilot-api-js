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
