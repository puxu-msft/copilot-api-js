import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import {
  //
  applyFetchMock,
  autoRestoreFetch,
} from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"
import { autoTestRuntime } from "../helpers/test-bootstrap"

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

// ----- upstream wire mock -----
//
// Instead of stubbing `~/lib/openai/chat-completions-client` (process-global
// `mock.module` leaks into sibling test files), let the real
// `createChatCompletions` client run against a mocked `globalThis.fetch`. We
// route by the upstream URL suffix, capture the payload from the request body,
// and count hits so assertions read the wire rather than a stubbed function.

let capturedPayload: ChatCompletionsPayload | undefined
let chatHits = 0
let throwOnce = false

function buildChatCompletionBody(model: string): string {
  return JSON.stringify({
    id: "chatcmpl-http-test",
    object: "chat.completion",
    created: 1,
    model,
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
  })
}

function buildChatCompletionSseFrames(model: string): Array<string> {
  return [
    `data: ${JSON.stringify({
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
    })}\n\n`,
    "data: [DONE]\n\n",
  ]
}

const upstreamFetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
  // The request layer always passes a plain string URL; narrow before matching
  // rather than String()-coercing a URL/Request into a base-stringified value.
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  // The request layer always serializes the JSON payload to a string body.
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as ChatCompletionsPayload) : ({} as ChatCompletionsPayload)

  if (url.endsWith("/chat/completions")) {
    chatHits += 1
    capturedPayload = payload
    if (throwOnce) {
      throwOnce = false
      throw new Error("upstream exploded")
    }
    if (payload.stream) {
      return createSseResponse(buildChatCompletionSseFrames(payload.model))
    }
    return new Response(buildChatCompletionBody(payload.model), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")

const app = createFullTestApp()

describe("POST /chat/completions", () => {
  autoTestRuntime()
  autoRestoreFetch()

  beforeEach(() => {
    capturedPayload = undefined
    chatHits = 0
    throwOnce = false
    upstreamFetchMock.mockClear()
    // The real chat-completions client checks state.copilotToken before issuing fetch.
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      fetchTimeout: 0,
    })
    applyFetchMock(upstreamFetchMock)
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
        type: "api_error",
        param: null,
        code: null,
      },
    })
    expect(chatHits).toBe(0)
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
    expect(chatHits).toBe(1)
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
    expect(chatHits).toBe(1)
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
    throwOnce = true

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
        type: "server_error",
        message: "upstream exploded",
        param: null,
        code: null,
      },
    })
  })
})
