import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { ServerSentEventMessage } from "fetch-event-stream"

import { createAnthropicMessages } from "~/lib/anthropic/client"
import { HTTPError } from "~/lib/error"
import { restoreStateForTests, setStateForTests, snapshotStateForTests } from "~/lib/state"
import type { MessagesPayload } from "~/types/api/anthropic"

const originalFetch = globalThis.fetch

function createPayload(overrides: Partial<MessagesPayload> = {}): MessagesPayload {
  return {
    model: "claude-sonnet-4.6",
    max_tokens: 128,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
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

describe("anthropic client", () => {
  const originalState = snapshotStateForTests()

  beforeEach(() => {
    setStateForTests({
      accountType: "individual",
      copilotToken: "copilot-test-token",
      vsCodeVersion: "1.100.0",
      fetchTimeout: 0,
      contextEditingMode: "off",
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
          id: "msg_123",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4.6",
          content: [{ type: "text", text: "hello back" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
          },
        }),
        {
          status: 200,
          headers: { "x-request-id": "resp-1" },
        },
      ))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const headersCapture: {
      request?: Record<string, string>
      response?: Record<string, string>
    } = {}
    const onPrepared = mock(() => {})

    const result = await createAnthropicMessages(createPayload(), {
      headersCapture,
      onPrepared,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      id: "msg_123",
      model: "claude-sonnet-4.6",
    })
    expect(headersCapture.request?.Authorization).toBe("***")
    expect(headersCapture.response?.["x-request-id"]).toBe("resp-1")
    expect(onPrepared).toHaveBeenCalledTimes(1)
  })

  test("returns an async iterable for streaming responses", async () => {
    globalThis.fetch = mock(async () =>
      createSseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4.6","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        "data: [DONE]\n\n",
      ])) as unknown as typeof fetch

    const result = await createAnthropicMessages(createPayload({ stream: true }))
    const iterator = (result as AsyncIterable<ServerSentEventMessage>)[Symbol.asyncIterator]()
    const first = await iterator.next()

    expect(first.done).toBe(false)
    expect(first.value?.event).toBe("message_start")
  })

  test("throws HTTPError for failed upstream responses", async () => {
    globalThis.fetch = mock(async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch

    await expect(createAnthropicMessages(createPayload())).rejects.toBeInstanceOf(HTTPError)
  })
})
