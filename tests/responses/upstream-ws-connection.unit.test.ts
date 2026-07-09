import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type { WebSocketLike } from "~/lib/openai/upstream-ws-connection"

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
})
