import type { ServerSentEventMessage } from "fetch-event-stream"

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { Model } from "~/lib/models/client"
import type { ResponsesPayload, ResponsesStreamEvent } from "~/types/api/openai-responses"

import { HTTPError } from "~/lib/error"
import { ENDPOINT } from "~/lib/models/endpoint"
import { createResponses } from "~/lib/openai/responses-client"
import { resetUpstreamWsManagerForTests, setUpstreamWsConnectionFactoryForTests } from "~/lib/openai/upstream-ws"
import { restoreStateForTests, setStateForTests, snapshotStateForTests } from "~/lib/state"

const originalFetch = globalThis.fetch

function createPayload(overrides: Partial<ResponsesPayload> = {}): ResponsesPayload {
  return {
    model: "gpt-4o",
    input: "hello",
    ...overrides,
  }
}

function createSseResponse(chunks: Array<string>) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
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
    globalThis.fetch = originalFetch
    resetUpstreamWsManagerForTests()
    setUpstreamWsConnectionFactoryForTests(null)
    restoreStateForTests(originalState)
  })

  test("returns JSON responses and captures sanitized headers", async () => {
    const fetchMock = mock(() =>
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
    globalThis.fetch = fetchMock as unknown as typeof fetch

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

  test("returns an async iterable for streaming responses", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        createSseResponse([
          'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","object":"response","created_at":1,"status":"in_progress","model":"gpt-4o","output":[],"usage":null,"tools":[],"tool_choice":"auto","parallel_tool_calls":false,"store":false}}\n\n',
          "data: [DONE]\n\n",
        ]),
      ),
    ) as unknown as typeof fetch

    const result = await createResponses(createPayload({ stream: true }))
    const iterator = (result as AsyncIterable<ServerSentEventMessage>)[Symbol.asyncIterator]()
    const first = await iterator.next()

    expect(first.done).toBe(false)
    expect(first.value?.event).toBe("response.created")
  })

  test("throws HTTPError for failed upstream responses", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("bad gateway", { status: 502 })),
    ) as unknown as typeof fetch

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
      close: () => {},
    }))
    setStateForTests({ upstreamWebSocket: true })

    globalThis.fetch = mock(() =>
      Promise.resolve(
        createSseResponse([
          'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","object":"response","created_at":1,"status":"in_progress","model":"gpt-4o","output":[],"usage":null,"tools":[],"tool_choice":"auto","parallel_tool_calls":false,"store":false}}\n\n',
          "data: [DONE]\n\n",
        ]),
      ),
    ) as unknown as typeof fetch

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
