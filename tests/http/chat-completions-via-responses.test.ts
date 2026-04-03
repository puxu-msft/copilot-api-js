import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"

import consola from "consola"
import type { ServerSentEventMessage } from "fetch-event-stream"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"
import type { ResponsesPayload } from "~/types/api/openai-responses"

import { getHistory } from "~/lib/history"
import { type StateSnapshot, restoreStateForTests, setModels, snapshotStateForTests } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { bootstrapTestRuntime, resetTestRuntime } from "../helpers/test-bootstrap"

let capturedResponsesPayload: ResponsesPayload | undefined
const createChatCompletionsMock = mock(async (_payload: ChatCompletionsPayload) => {
  throw new Error("createChatCompletions should not be called for responses-only models")
})

const createResponsesMock = mock(async (payload: ResponsesPayload, opts?: { onPrepared?: (request: any) => void }) => {
  capturedResponsesPayload = payload
  opts?.onPrepared?.({
    wire: payload,
    headers: { "x-test": "1" },
  })

  if (payload.stream) {
    return createMockResponsesStream(payload.model)
  }

  return {
    id: "resp-http-test",
    object: "response",
    created_at: 1,
    status: "completed",
    model: payload.model,
    output: [
      {
        type: "message",
        id: "msg-http-test",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Translated response", annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 5,
      output_tokens: 3,
      total_tokens: 8,
    },
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
  }
})

function createMockResponsesStream(model: string): AsyncGenerator<ServerSentEventMessage> {
  return (async function* () {
    yield {
      event: "response.created",
      data: JSON.stringify({
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
      }),
    }
    yield {
      event: "response.output_text.delta",
      data: JSON.stringify({
        type: "response.output_text.delta",
        sequence_number: 1,
        output_index: 0,
        content_index: 0,
        delta: "Hello via responses stream",
      }),
    }
    yield {
      event: "response.completed",
      data: JSON.stringify({
        type: "response.completed",
        sequence_number: 2,
        response: {
          id: "resp-stream-test",
          object: "response",
          created_at: 1,
          status: "completed",
          model,
          output: [],
          usage: {
            input_tokens: 9,
            output_tokens: 4,
            total_tokens: 13,
          },
          tools: [],
          tool_choice: "auto",
          parallel_tool_calls: false,
          store: false,
        },
      }),
    }
  })()
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Bun hoists module mocks before imports
mock.module("~/lib/openai/chat-completions-client", () => ({
  createChatCompletions: createChatCompletionsMock,
}))

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Bun hoists module mocks before imports
mock.module("~/lib/openai/responses-client", () => ({
  createResponses: createResponsesMock,
}))

const { createFullTestApp } = await import("../helpers/test-app")

const app = createFullTestApp()

describe("POST /chat/completions via /responses translation", () => {
  let snapshot: StateSnapshot
  let warnSpy: ReturnType<typeof spyOn>

  beforeAll(() => {
    bootstrapTestRuntime()
    warnSpy = spyOn(consola, "warn").mockImplementation((() => undefined) as unknown as typeof consola.warn)
  })

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    capturedResponsesPayload = undefined
    createChatCompletionsMock.mockClear()
    createResponsesMock.mockClear()
    warnSpy.mockClear()
  })

  afterEach(() => {
    restoreStateForTests(snapshot)
    resetTestRuntime()
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

    expect(createChatCompletionsMock).not.toHaveBeenCalled()
    expect(createResponsesMock).toHaveBeenCalledTimes(1)
    expect(capturedResponsesPayload).toMatchObject({
      model: "gpt-5-resp",
      instructions: "be concise",
      max_output_tokens: 4096,
      tools: [{ type: "function", name: "lookup_weather", description: "Lookup weather" }],
      tool_choice: { type: "function", name: "lookup_weather" },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    })

    const historyEntry = getHistory({ endpoint: "openai-chat-completions" }).entries[0]
    expect(historyEntry?.wireRequest?.format).toBe("openai-responses")
    expect(historyEntry?.wireRequest?.messageCount).toBe(1)
    expect(historyEntry?.warningMessages).toEqual([
      {
        code: "cc_to_responses_dropped_params",
        message: "Chat Completions -> Responses translation dropped unsupported params: stop",
      },
    ])
    expect(warnSpy).toHaveBeenCalledWith(
      "[CC→Responses] model=gpt-5-resp Chat Completions -> Responses translation dropped unsupported params: stop",
    )
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
    expect(historyEntry?.response?.success).toBe(true)
    expect(historyEntry?.response?.content).toMatchObject({
      role: "assistant",
      content: "Hello via responses stream",
    })
  })

  test("fails the request context when the translated upstream stream emits response.failed", async () => {
    createResponsesMock.mockImplementationOnce(async (payload: ResponsesPayload, opts?: { onPrepared?: (request: any) => void }) => {
      capturedResponsesPayload = payload
      opts?.onPrepared?.({
        wire: payload,
        headers: { "x-test": "1" },
      })

      return (async function* () {
        yield {
          event: "response.failed",
          data: JSON.stringify({
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
          }),
        }
      })()
    })

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
        messages: [{ role: "user", content: "fail please" }],
      }),
    })

    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body).toContain("event: error")
    expect(body).toContain("Translated upstream failure")

    const historyEntry = getHistory({ endpoint: "openai-chat-completions" }).entries[0]
    expect(historyEntry?.response?.success).toBe(false)
    expect(historyEntry?.response?.error).toBe("Translated upstream failure")
  })
})
