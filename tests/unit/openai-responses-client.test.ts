import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { ServerSentEventMessage } from "fetch-event-stream"

import { HTTPError } from "~/lib/error"
import { createResponses } from "~/lib/openai/responses-client"
import { restoreStateForTests, setStateForTests, snapshotStateForTests } from "~/lib/state"
import type { ResponsesPayload } from "~/types/api/openai-responses"

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
    setStateForTests({
      accountType: "individual",
      copilotToken: "copilot-test-token",
      vsCodeVersion: "1.100.0",
      fetchTimeout: 0,
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreStateForTests(originalState)
  })

  test("returns JSON responses and captures sanitized headers", async () => {
    const fetchMock = mock(async () =>
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
      ))
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
    globalThis.fetch = mock(async () =>
      createSseResponse([
        'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","object":"response","created_at":1,"status":"in_progress","model":"gpt-4o","output":[],"usage":null,"tools":[],"tool_choice":"auto","parallel_tool_calls":false,"store":false}}\n\n',
        "data: [DONE]\n\n",
      ])) as unknown as typeof fetch

    const result = await createResponses(createPayload({ stream: true }))
    const iterator = (result as AsyncIterable<ServerSentEventMessage>)[Symbol.asyncIterator]()
    const first = await iterator.next()

    expect(first.done).toBe(false)
    expect(first.value?.event).toBe("response.created")
  })

  test("throws HTTPError for failed upstream responses", async () => {
    globalThis.fetch = mock(async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch

    await expect(createResponses(createPayload())).rejects.toBeInstanceOf(HTTPError)
  })
})
