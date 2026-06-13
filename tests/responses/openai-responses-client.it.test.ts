import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type { Model } from "~/lib/models/client"
import type {
  //
  ResponsesPayload,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import { HTTPError } from "~/lib/error"
import { ENDPOINT } from "~/lib/models/endpoint"
import { createResponses } from "~/lib/openai/responses-client"
import {
  //
  resetUpstreamWsManagerForTests,
  setUpstreamWsConnectionFactoryForTests,
} from "~/lib/openai/upstream-ws"
import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

import {
  //
  restoreFetch,
  setFetchMock,
} from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"

function createPayload(overrides: Partial<ResponsesPayload> = {}): ResponsesPayload {
  return {
    model: "gpt-4o",
    input: "hello",
    ...overrides,
  }
}

describe("responses client", () => {
  const originalState = snapshotStateForTests()

  beforeEach(() => {
    resetUpstreamWsManagerForTests()
    setUpstreamWsConnectionFactoryForTests(null)
    setStateForTests({
      accountType: "individual",
      copilotToken: "copilot-test-token",
      vsCodeVersion: "1.100.0",
      fetchTimeout: 0,
      upstreamWebSocket: false,
    })
  })

  afterEach(() => {
    restoreFetch()
    resetUpstreamWsManagerForTests()
    setUpstreamWsConnectionFactoryForTests(null)
    restoreStateForTests(originalState)
  })

  test("returns JSON responses and captures sanitized headers", async () => {
    const fetchMock = setFetchMock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "resp_123",
            object: "response",
            created_at: 1,
            status: "completed",
            model: "gpt-4o",
            output: [],
            usage: {
              input_tokens: 3,
              output_tokens: 2,
              total_tokens: 5,
            },
            tools: [],
            tool_choice: "auto",
            parallel_tool_calls: false,
            store: false,
          }),
          {
            status: 200,
            headers: { "x-request-id": "resp-2" },
          },
        ),
      ),
    )

    const headersCapture: {
      request?: Record<string, string>
      response?: Record<string, string>
    } = {}
    const onPrepared = mock(() => {})

    const result = await createResponses(createPayload(), {
      headersCapture,
      onPrepared,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      id: "resp_123",
      model: "gpt-4o",
    })
    expect(headersCapture.request?.Authorization).toBe("***")
    expect(headersCapture.response?.["x-request-id"]).toBe("resp-2")
    expect(onPrepared).toHaveBeenCalledTimes(1)
  })

  test("disables Bun's built-in fetch timeout on the upstream HTTP request", async () => {
    // Bun's native fetch enforces a 300s built-in timeout that ignores our
    // AbortSignal-based fetchTimeout; the upstream call must pass timeout:false
    // so `timeouts.response_header` is the single source of truth. See DISABLE_BUILTIN_FETCH_TIMEOUT.
    const fetchMock = setFetchMock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "resp_x",
            object: "response",
            created_at: 1,
            status: "completed",
            model: "gpt-4o",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            tools: [],
            tool_choice: "auto",
            parallel_tool_calls: false,
            store: false,
          }),
          { status: 200 },
        ),
      ),
    )

    await createResponses(createPayload())

    const init = fetchMock.mock.calls[0]?.[1] as { timeout?: unknown } | undefined
    expect(init?.timeout).toBe(false)
  })

  test("returns an async iterable for streaming responses", async () => {
    setFetchMock(() =>
      Promise.resolve(
        createSseResponse([
          'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","object":"response","created_at":1,"status":"in_progress","model":"gpt-4o","output":[],"usage":null,"tools":[],"tool_choice":"auto","parallel_tool_calls":false,"store":false}}\n\n',
          "data: [DONE]\n\n",
        ]),
      ),
    )

    const result = await createResponses(createPayload({ stream: true }))
    const iterator = (result as AsyncIterable<ServerSentEventMessage>)[Symbol.asyncIterator]()
    const first = await iterator.next()

    expect(first.done).toBe(false)
    expect(first.value?.event).toBe("response.created")
  })

  test("throws HTTPError for failed upstream responses", async () => {
    setFetchMock(() => Promise.resolve(new Response("bad gateway", { status: 502 })))

    try {
      await createResponses(createPayload())
      throw new Error("Expected createResponses to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
    }
  })

  test("uses upstream websocket for streaming responses when enabled and supported", async () => {
    let open = false
    const connect = mock(() => {
      open = true
      return Promise.resolve()
    })
    const sendRequest = mock(() =>
      createAsyncIterable<ResponsesStreamEvent>([
        {
          type: "response.created",
          sequence_number: 0,
          response: {
            id: "resp_1",
            object: "response",
            created_at: 1,
            status: "in_progress",
            model: "gpt-4o",
            output: [],
            usage: null,
            tools: [],
            tool_choice: "auto",
            parallel_tool_calls: false,
            store: false,
          },
        },
        {
          type: "response.completed",
          sequence_number: 1,
          response: {
            id: "resp_1",
            object: "response",
            created_at: 1,
            status: "completed",
            model: "gpt-4o",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            tools: [],
            tool_choice: "auto",
            parallel_tool_calls: false,
            store: false,
          },
        },
      ]),
    )
    setUpstreamWsConnectionFactoryForTests(() => ({
      connect,
      sendRequest,
      get isOpen() {
        return open
      },
      get isBusy() {
        return false
      },
      statefulMarker: undefined,
      model: "gpt-4o",
      conversationId: undefined,
      handshakeHeaders: {},
      close: () => {},
    }))
    setStateForTests({ upstreamWebSocket: true })

    const transports: Array<string> = []
    const model = {
      id: "gpt-4o",
      name: "gpt-4o",
      vendor: "OpenAI",
      object: "model",
      version: "gpt-4o",
      model_picker_enabled: true,
      preview: false,
      supported_endpoints: [ENDPOINT.RESPONSES, ENDPOINT.WS_RESPONSES],
    } as Model

    const result = await createResponses(createPayload({ stream: true }), {
      resolvedModel: model,
      onTransport: (transport) => transports.push(transport),
    })

    const iterator = (result as AsyncIterable<ServerSentEventMessage>)[Symbol.asyncIterator]()
    const first = await iterator.next()

    expect(connect).toHaveBeenCalledTimes(1)
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(first.value?.event).toBe("response.created")
    expect(transports).toEqual(["upstream-ws"])
  })

  test("falls back to HTTP before first websocket event", async () => {
    let open = false
    setUpstreamWsConnectionFactoryForTests(() => ({
      connect: () => {
        open = true
        return Promise.resolve()
      },
      sendRequest: () => createRejectingAsyncIterable(new Error("handshake finished but no first event")),
      get isOpen() {
        return open
      },
      get isBusy() {
        return false
      },
      statefulMarker: undefined,
      model: "gpt-4o",
      conversationId: undefined,
      handshakeHeaders: {},
      close: () => {},
    }))
    setStateForTests({ upstreamWebSocket: true })

    setFetchMock(() =>
      Promise.resolve(
        createSseResponse([
          'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","object":"response","created_at":1,"status":"in_progress","model":"gpt-4o","output":[],"usage":null,"tools":[],"tool_choice":"auto","parallel_tool_calls":false,"store":false}}\n\n',
          "data: [DONE]\n\n",
        ]),
      ),
    )

    const transports: Array<string> = []
    const model = {
      id: "gpt-4o",
      name: "gpt-4o",
      vendor: "OpenAI",
      object: "model",
      version: "gpt-4o",
      model_picker_enabled: true,
      preview: false,
      supported_endpoints: [ENDPOINT.RESPONSES, ENDPOINT.WS_RESPONSES],
    } as Model

    const result = await createResponses(createPayload({ stream: true }), {
      resolvedModel: model,
      onTransport: (transport) => transports.push(transport),
    })

    const iterator = (result as AsyncIterable<ServerSentEventMessage>)[Symbol.asyncIterator]()
    const first = await iterator.next()

    expect(first.value?.event).toBe("response.created")
    expect(transports).toEqual(["upstream-ws-fallback"])
  })

  test("propagates client abort signal into upstream WS sendRequest", async () => {
    let sentAbortSignal: AbortSignal | undefined
    let rejectQueue: (error: Error) => void = () => {}

    let open = false
    setUpstreamWsConnectionFactoryForTests(() => ({
      connect: () => {
        open = true
        return Promise.resolve()
      },
      sendRequest: (_payload, callOpts) => {
        sentAbortSignal = callOpts?.abortSignal
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                return new Promise<IteratorResult<ResponsesStreamEvent>>((_, reject) => {
                  rejectQueue = reject
                  callOpts?.abortSignal?.addEventListener("abort", () => reject(new Error("Upstream WebSocket request aborted")), { once: true })
                })
              },
            }
          },
        }
      },
      get isOpen() {
        return open
      },
      get isBusy() {
        return false
      },
      statefulMarker: undefined,
      model: "gpt-4o",
      conversationId: undefined,
      handshakeHeaders: {},
      close: () => {},
    }))

    // HTTP fallback target — should be hit after WS aborts pre-first-event
    setFetchMock(() =>
      Promise.resolve(
        createSseResponse([
          'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","object":"response","created_at":1,"status":"in_progress","model":"gpt-4o","output":[],"usage":null,"tools":[],"tool_choice":"auto","parallel_tool_calls":false,"store":false}}\n\n',
          "data: [DONE]\n\n",
        ]),
      ),
    )

    setStateForTests({ upstreamWebSocket: true })
    const clientAbort = new AbortController()
    const model = {
      id: "gpt-4o",
      name: "gpt-4o",
      vendor: "OpenAI",
      object: "model",
      version: "gpt-4o",
      model_picker_enabled: true,
      preview: false,
      supported_endpoints: [ENDPOINT.RESPONSES, ENDPOINT.WS_RESPONSES],
    } as Model

    const transports: Array<string> = []
    const createPromise = createResponses(createPayload({ stream: true }), {
      resolvedModel: model,
      clientAbortSignal: clientAbort.signal,
      onTransport: (t) => transports.push(t),
    })

    // Wait a tick to ensure sendRequest has been called and the abort listener wired up
    await new Promise((r) => setTimeout(r, 5))
    expect(sentAbortSignal).toBeDefined()
    expect(sentAbortSignal?.aborted).toBe(false)

    clientAbort.abort()
    // Drain pending rejection (simulate connection's failRequest)
    rejectQueue(new Error("aborted via signal"))

    const result = await createPromise
    const iterator = (result as AsyncIterable<ServerSentEventMessage>)[Symbol.asyncIterator]()
    const first = await iterator.next()

    // Should have fallen back to HTTP (the mocked fetch)
    expect(first.value?.event).toBe("response.created")
    expect(transports).toEqual(["upstream-ws-fallback"])
  })

  test("WS generator aborts upstream request when consumer stops iterating via shared abort signal", async () => {
    let abortFired = false
    let yielded = false
    let releaseSecondEvent: () => void = () => {}

    let open = false
    setUpstreamWsConnectionFactoryForTests(() => ({
      connect: () => {
        open = true
        return Promise.resolve()
      },
      sendRequest: (_payload, callOpts) => {
        callOpts?.abortSignal?.addEventListener("abort", () => {
          abortFired = true
        })
        return {
          [Symbol.asyncIterator]() {
            let sentFirst = false
            return {
              next() {
                if (!sentFirst) {
                  sentFirst = true
                  yielded = true
                  return Promise.resolve({
                    done: false,
                    value: {
                      type: "response.created",
                      sequence_number: 0,
                      response: {
                        id: "resp_1",
                        object: "response",
                        created_at: 1,
                        status: "in_progress",
                        model: "gpt-4o",
                        output: [],
                        usage: null,
                        tools: [],
                        tool_choice: "auto",
                        parallel_tool_calls: false,
                        store: false,
                      },
                    } as ResponsesStreamEvent,
                  })
                }
                return new Promise<IteratorResult<ResponsesStreamEvent>>((resolve) => {
                  releaseSecondEvent = () => resolve({ done: true, value: undefined })
                  callOpts?.abortSignal?.addEventListener("abort", () => resolve({ done: true, value: undefined }), {
                    once: true,
                  })
                })
              },
            }
          },
        }
      },
      get isOpen() {
        return open
      },
      get isBusy() {
        return false
      },
      statefulMarker: undefined,
      model: "gpt-4o",
      conversationId: undefined,
      handshakeHeaders: {},
      close: () => {},
    }))

    setStateForTests({ upstreamWebSocket: true })
    const model = {
      id: "gpt-4o",
      name: "gpt-4o",
      vendor: "OpenAI",
      object: "model",
      version: "gpt-4o",
      model_picker_enabled: true,
      preview: false,
      supported_endpoints: [ENDPOINT.RESPONSES, ENDPOINT.WS_RESPONSES],
    } as Model

    const result = await createResponses(createPayload({ stream: true }), { resolvedModel: model })
    const generator = result as AsyncGenerator<ServerSentEventMessage>

    const first = await generator.next()
    expect(first.value?.event).toBe("response.created")
    expect(yielded).toBe(true)

    // Consumer aborts by calling .return() — generator's finally must abort the WS request.
    await generator.return(undefined)
    expect(abortFired).toBe(true)
    releaseSecondEvent()
  })

  test("falls back to HTTP when manager.create() throws during shutdown (TOCTOU window)", async () => {
    // Simulate the shutdown race: canUseUpstreamWebSocket() passes (state has
    // upstreamWebSocket=true and manager not yet stopped), but by the time we
    // call manager.create() the manager has called stopNew() and create()
    // throws. The request must transparently fall back to HTTP — bubbling the
    // error to the client would violate "WS failures must never fail requests".
    setUpstreamWsConnectionFactoryForTests(() => {
      throw new Error("Upstream WebSocket manager is not accepting new work")
    })
    setStateForTests({ upstreamWebSocket: true })

    setFetchMock(() =>
      Promise.resolve(
        createSseResponse([
          'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_http","object":"response","created_at":1,"status":"in_progress","model":"gpt-4o","output":[],"usage":null,"tools":[],"tool_choice":"auto","parallel_tool_calls":false,"store":false}}\n\n',
          "data: [DONE]\n\n",
        ]),
      ),
    )

    const transports: Array<string> = []
    const model = {
      id: "gpt-4o",
      name: "gpt-4o",
      vendor: "OpenAI",
      object: "model",
      version: "gpt-4o",
      model_picker_enabled: true,
      preview: false,
      supported_endpoints: [ENDPOINT.RESPONSES, ENDPOINT.WS_RESPONSES],
    } as Model

    // Must not throw — must degrade to HTTP
    const result = await createResponses(createPayload({ stream: true }), {
      resolvedModel: model,
      onTransport: (t) => transports.push(t),
    })

    const iterator = (result as AsyncIterable<ServerSentEventMessage>)[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value?.event).toBe("response.created")
    expect(transports).toEqual(["upstream-ws-fallback"])
  })
})

function createAsyncIterable<T>(values: Array<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        next() {
          if (index >= values.length) {
            return Promise.resolve({ done: true, value: undefined })
          }
          const value = values[index++]
          return Promise.resolve({ done: false, value })
        },
      }
    },
  }
}

function createRejectingAsyncIterable(error: Error): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return Promise.reject(error)
        },
      }
    },
  }
}
