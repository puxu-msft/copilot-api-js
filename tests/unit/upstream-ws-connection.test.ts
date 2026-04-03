import { beforeEach, describe, expect, test } from "bun:test"

import type { WebSocketLike } from "~/lib/openai/upstream-ws-connection"

import { createUpstreamWsConnection, isCapiWebSocketError } from "~/lib/openai/upstream-ws-connection"

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
    expect(socket.closeCalls).toEqual([{ code: 1001, reason: "Handshake failed" }])
    expect(connection.isOpen).toBe(false)
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
})
