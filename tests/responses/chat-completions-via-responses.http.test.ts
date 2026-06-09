import {
  //
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import type { ResponsesPayload } from "~/types/api/openai-responses"

import { getHistory } from "~/lib/history"
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

// ----- upstream wire mock -----
//
// Responses-only models translate the incoming /chat/completions request into a
// /responses upstream call. Rather than stubbing the client modules (process-
// global `mock.module` leaks into sibling test files), the real clients run
// against a mocked `globalThis.fetch`. We route by upstream URL suffix, capture
// the translated payload from the request body, and let individual tests swap
// the /responses response via `responseFactory`.

let capturedResponsesPayload: ResponsesPayload | undefined
let responsesHits = 0
let chatHits = 0
let responseFactory: (payload: ResponsesPayload) => Response

function buildDefaultResponse(model: string): Response {
  return new Response(
    JSON.stringify({
      id: "resp-http-test",
      object: "response",
      created_at: 1,
      status: "completed",
      model,
      output: [
        {
          type: "message",
          id: "msg-http-test",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Translated response", annotations: [] }],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function buildStreamResponse(model: string): Response {
  return createSseResponse([
    `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      sequence_number: 0,
      response: {
        id: "resp-stream-test",
        object: "response",
        created_at: 1,
        status: "in_progress",
        model,
        output: [],
        usage: null,
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
      },
    })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta",
      sequence_number: 1,
      output_index: 0,
      content_index: 0,
      delta: "Hello via responses stream",
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: "resp-stream-test",
        object: "response",
        created_at: 1,
        status: "completed",
        model,
        output: [],
        usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
      },
    })}\n\n`,
    "data: [DONE]\n\n",
  ])
}

const upstreamFetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
  // The request layer always passes a plain string URL; narrow before matching
  // rather than String()-coercing a URL/Request into a base-stringified value.
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url

  if (url.endsWith("/chat/completions")) {
    chatHits += 1
    throw new Error("createChatCompletions should not be called for responses-only models")
  }

  if (url.endsWith("/responses")) {
    responsesHits += 1
    // The request layer always serializes the JSON payload to a string body.
    if (typeof init?.body !== "string") {
      throw new TypeError(`expected string body in mock, got ${typeof init?.body}`)
    }
    capturedResponsesPayload = JSON.parse(init.body) as ResponsesPayload
    return responseFactory(capturedResponsesPayload)
  }

  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")

const app = createFullTestApp()

describe("POST /chat/completions via /responses translation", () => {
  autoTestRuntime()
  autoRestoreFetch()

  let warnSpy: ReturnType<typeof spyOn>

  beforeAll(() => {
    warnSpy = spyOn(consola, "warn").mockImplementation((() => undefined) as unknown as typeof consola.warn)
  })

  beforeEach(() => {
    capturedResponsesPayload = undefined
    responsesHits = 0
    chatHits = 0
    upstreamFetchMock.mockClear()
    warnSpy.mockClear()
    responseFactory = (payload) => (payload.stream ? buildStreamResponse(payload.model) : buildDefaultResponse(payload.model))
    // The real responses client checks state.copilotToken before issuing fetch.
    setStateForTests({ copilotToken: "test-token" })
    applyFetchMock(upstreamFetchMock)
  })

  afterAll(() => {
    warnSpy.mockRestore()
  })

  test("translates non-streaming chat completions requests for responses-only models", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("gpt-5-resp", {
          vendor: "OpenAI",
          supported_endpoints: ["/responses"],
        }),
      ],
    })

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-resp",
        stream: false,
        stop: ["END"],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup_weather",
              description: "Lookup weather",
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "lookup_weather" } },
        messages: [
          { role: "system", content: "be concise" },
          { role: "user", content: "hello" },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      id: "resp-http-test",
      object: "chat.completion",
      model: "gpt-5-resp",
      choices: [
        {
          message: { role: "assistant", content: "Translated response" },
          finish_reason: "stop",
        },
      ],
    })

    expect(chatHits).toBe(0)
    expect(responsesHits).toBe(1)
    expect(capturedResponsesPayload).toMatchObject({
      model: "gpt-5-resp",
      instructions: "be concise",
      max_output_tokens: 4096,
      tools: [{ type: "function", name: "lookup_weather", description: "Lookup weather" }],
      tool_choice: { type: "function", name: "lookup_weather" },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    })

    const historyEntry = getHistory({ endpoint: "openai-chat-completions" }).entries[0]
    expect(historyEntry?.outboundRequest?.format).toBe("openai-responses")
    expect(historyEntry?.outboundRequest?.messageCount).toBe(1)
    expect(historyEntry?.warningMessages).toEqual([
      {
        code: "cc_to_responses_dropped_params",
        message: "Chat Completions -> Responses translation dropped unsupported params: stop",
      },
    ])
    expect(warnSpy).toHaveBeenCalledWith("[CC→Responses] model=gpt-5-resp Chat Completions -> Responses translation dropped unsupported params: stop")
  })

  test("normalizes translated call ids before sending to responses upstream by default", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("gpt-5-resp", {
          vendor: "OpenAI",
          supported_endpoints: ["/responses"],
        }),
      ],
    })

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-resp",
        stream: false,
        messages: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_weather",
                type: "function",
                function: { name: "lookup_weather", arguments: '{"city":"Paris"}' },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_weather",
            content: "sunny",
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(capturedResponsesPayload?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
      {
        type: "function_call",
        id: "fc_weather",
        call_id: "fc_weather",
        name: "lookup_weather",
        arguments: '{"city":"Paris"}',
      },
      {
        type: "function_call_output",
        call_id: "fc_weather",
        output: "sunny",
      },
    ])
  })

  test("streams translated chat completion chunks from responses upstream", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("gpt-5-resp", {
          vendor: "OpenAI",
          supported_endpoints: ["/responses"],
        }),
      ],
    })

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-resp",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "stream please" }],
      }),
    })

    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body).toContain("chat.completion.chunk")
    expect(body).toContain("Hello via responses stream")
    expect(body).toContain('"choices":[]')

    const historyEntry = getHistory({ endpoint: "openai-chat-completions" }).entries[0]
    expect(historyEntry?.outboundResponse?.success).toBe(true)
    expect(historyEntry?.outboundResponse?.content).toMatchObject({
      role: "assistant",
      content: "Hello via responses stream",
    })
  })

  test("fails the request context when the translated upstream stream emits response.failed", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("gpt-5-resp", {
          vendor: "OpenAI",
          supported_endpoints: ["/responses"],
        }),
      ],
    })

    // Override the upstream stream just for this test: a response.failed frame.
    responseFactory = (payload) =>
      createSseResponse([
        `event: response.failed\ndata: ${JSON.stringify({
          type: "response.failed",
          sequence_number: 0,
          response: {
            id: "resp-stream-failed",
            object: "response",
            created_at: 1,
            status: "failed",
            model: payload.model,
            output: [],
            usage: null,
            error: {
              message: "Translated upstream failure",
              type: "server_error",
              code: "boom",
            },
            tools: [],
            tool_choice: "auto",
            parallel_tool_calls: false,
            store: false,
          },
        })}\n\n`,
      ])

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-resp",
        stream: true,
        messages: [{ role: "user", content: "fail please" }],
      }),
    })

    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body).toContain("event: error")
    expect(body).toContain("Translated upstream failure")

    const historyEntry = getHistory({ endpoint: "openai-chat-completions" }).entries[0]
    expect(historyEntry?.outboundResponse?.success).toBe(false)
    expect(historyEntry?.outboundResponse?.error).toBe("Translated upstream failure")
  })
})
