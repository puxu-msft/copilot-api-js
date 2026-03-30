import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"

import type { ServerSentEventMessage } from "fetch-event-stream"

import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { type StateSnapshot, restoreStateForTests, setModels, snapshotStateForTests } from "~/lib/state"
import { prepareChatCompletionsRequest } from "~/lib/openai/request-preparation"

import { mockModel } from "../helpers/factories"
import { bootstrapTestRuntime, resetTestRuntime } from "../helpers/test-bootstrap"

let capturedPayload: ChatCompletionsPayload | undefined

interface ChatCompletionHttpBody {
  id: string
  object: string
  model: string
  choices: Array<{
    message: {
      content: string | null
    }
  }>
}

const createChatCompletionsMock = mock(async (payload: ChatCompletionsPayload) => {
  capturedPayload = payload

  if (payload.stream) {
    return createMockChatStream(payload.model)
  }

  return {
    id: "chatcmpl-http-test",
    object: "chat.completion",
    created: 1,
    model: payload.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Mocked response" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    },
  }
})

function createMockChatStream(model: string): AsyncGenerator<ServerSentEventMessage> {
  return (async function* () {
    yield {
      event: "message",
      data: JSON.stringify({
        id: "chatcmpl-stream-test",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Hello from mocked chat stream" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
    }
    yield {
      data: "[DONE]",
    }
  })()
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Bun hoists module mocks before imports
mock.module("~/lib/openai/chat-completions-client", () => ({
  createChatCompletions: createChatCompletionsMock,
  prepareChatCompletionsRequest,
}))

const { createFullTestApp } = await import("../helpers/test-app")

const app = createFullTestApp()

describe("POST /chat/completions", () => {
  let snapshot: StateSnapshot

  beforeAll(() => {
    bootstrapTestRuntime()
  })

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    capturedPayload = undefined
    createChatCompletionsMock.mockClear()
  })

  afterEach(() => {
    restoreStateForTests(snapshot)
    resetTestRuntime()
  })

  test("returns 400 when the selected model does not support /chat/completions", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("claude-sonnet-4.6", {
          vendor: "Anthropic",
          supported_endpoints: ["/v1/messages"],
        }),
      ],
    })

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        messages: [{ role: "user", content: "Hello" }],
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: {
        message: 'Model "claude-sonnet-4.6" does not support the /chat/completions endpoint',
        type: "error",
      },
    })
    expect(createChatCompletionsMock).not.toHaveBeenCalled()
  })

  test("returns mocked non-streaming completion through the real handler path", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello from HTTP test" }],
        stream: false,
      }),
    })

    const body = (await res.json()) as ChatCompletionHttpBody

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      id: "chatcmpl-http-test",
      object: "chat.completion",
      model: "gpt-4o",
    })
    expect(body.choices[0].message.content).toBe("Mocked response")
    expect(createChatCompletionsMock).toHaveBeenCalledTimes(1)
    expect(capturedPayload?.model).toBe("gpt-4o")
    expect(capturedPayload?.messages).toHaveLength(1)
  })

  test("returns an SSE response when the request enables streaming", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Stream please" }],
        stream: true,
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(createChatCompletionsMock).toHaveBeenCalledTimes(1)
    expect(capturedPayload?.stream).toBe(true)
    expect(capturedPayload?.model).toBe("gpt-4o")
  })

  test("forwards upstream HTTP errors through the shared error handler", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })
    createChatCompletionsMock.mockImplementationOnce(async () => {
      throw new Error("upstream exploded")
    })

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello from HTTP test" }],
        stream: false,
      }),
    })

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: {
        type: "error",
        message: "upstream exploded",
      },
    })
  })
})
