import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"

import type { ServerSentEventMessage } from "fetch-event-stream"

import type { MessagesPayload } from "~/types/api/anthropic"

import { prepareAnthropicRequest } from "~/lib/anthropic/request-preparation"
import { type StateSnapshot, restoreStateForTests, setModels, snapshotStateForTests } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { bootstrapTestRuntime, resetTestRuntime } from "../helpers/test-bootstrap"

let capturedPayload: MessagesPayload | undefined

const createAnthropicMessagesMock = mock(async (payload: MessagesPayload) => {
  capturedPayload = payload

  if (payload.stream) {
    return createMockAnthropicStream(payload.model)
  }

  return {
    id: "msg-http-test",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Mocked anthropic response",
      },
    ],
    model: payload.model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 9,
      output_tokens: 4,
    },
  }
})

function createMockAnthropicStream(model: string): AsyncGenerator<ServerSentEventMessage> {
  return (async function* () {
    yield {
      event: "message_start",
      data: JSON.stringify({
        type: "message_start",
        message: {
          id: "msg-stream-test",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 12,
            output_tokens: 0,
          },
        },
      }),
    }
    yield {
      event: "content_block_start",
      data: JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "text",
          text: "",
        },
      }),
    }
    yield {
      event: "content_block_delta",
      data: JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "Hello from mocked stream",
        },
      }),
    }
    yield {
      event: "content_block_stop",
      data: JSON.stringify({
        type: "content_block_stop",
        index: 0,
      }),
    }
    yield {
      event: "message_delta",
      data: JSON.stringify({
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
        },
        usage: {
          output_tokens: 6,
        },
      }),
    }
    yield {
      event: "message_stop",
      data: JSON.stringify({
        type: "message_stop",
      }),
    }
    yield {
      data: "[DONE]",
    }
  })()
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Bun hoists module mocks before imports
mock.module("~/lib/anthropic/client", () => ({
  createAnthropicMessages: createAnthropicMessagesMock,
  prepareAnthropicRequest,
}))

const { createFullTestApp } = await import("../helpers/test-app")

const app = createFullTestApp()

interface MessagesHttpBody {
  id: string
  type: string
  model: string
  stop_reason: string
  content: Array<{
    type: string
    text?: string
  }>
}

interface ErrorHttpBody {
  error: {
    message: string
    type: string
  }
}

describe("POST /v1/messages", () => {
  let snapshot: StateSnapshot

  beforeAll(() => {
    bootstrapTestRuntime()
  })

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    capturedPayload = undefined
    createAnthropicMessagesMock.mockClear()
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })
  })

  afterEach(() => {
    restoreStateForTests(snapshot)
    resetTestRuntime()
  })

  test("returns 400 when the selected model does not support /v1/messages", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 32,
      }),
    })

    const body = (await res.json()) as ErrorHttpBody

    expect(res.status).toBe(400)
    expect(body).toEqual({
      error: {
        message: 'Model "gpt-4o" does not support /v1/messages: vendor is "OpenAI", not Anthropic',
        type: "error",
      },
    })
    expect(createAnthropicMessagesMock).not.toHaveBeenCalled()
  })

  test("resolves Anthropic aliases and returns the mocked non-streaming response", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("claude-opus-4.6", {
          vendor: "Anthropic",
          supported_endpoints: ["/v1/messages"],
        }),
      ],
    })

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "opus",
        messages: [{ role: "user", content: "Hello from HTTP test" }],
        max_tokens: 64,
        stream: false,
      }),
    })

    const body = (await res.json()) as MessagesHttpBody

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      id: "msg-http-test",
      type: "message",
      model: "claude-opus-4.6",
      stop_reason: "end_turn",
    })
    expect(body.content[0]?.text).toBe("Mocked anthropic response")
    expect(createAnthropicMessagesMock).toHaveBeenCalledTimes(1)
    expect(capturedPayload?.model).toBe("claude-opus-4.6")
    expect(capturedPayload?.stream).toBe(false)
    expect(capturedPayload?.messages).toHaveLength(1)
  })

  test("streams SSE events through the real Anthropic handler path", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("claude-sonnet-4.6", {
          vendor: "Anthropic",
          supported_endpoints: ["/v1/messages"],
        }),
      ],
    })

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        messages: [{ role: "user", content: "Please stream" }],
        max_tokens: 64,
        stream: true,
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(createAnthropicMessagesMock).toHaveBeenCalledTimes(1)
    expect(capturedPayload?.model).toBe("claude-sonnet-4.6")
    expect(capturedPayload?.stream).toBe(true)
  })

  test("forwards upstream failures through the shared error handler", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("claude-sonnet-4.6", {
          vendor: "Anthropic",
          supported_endpoints: ["/v1/messages"],
        }),
      ],
    })
    createAnthropicMessagesMock.mockImplementationOnce(async () => {
      throw new Error("anthropic upstream exploded")
    })

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        messages: [{ role: "user", content: "Hello from HTTP test" }],
        max_tokens: 64,
        stream: false,
      }),
    })

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: {
        type: "error",
        message: "anthropic upstream exploded",
      },
    })
  })
})
