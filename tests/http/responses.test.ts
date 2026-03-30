import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"

import type { ResponsesPayload } from "~/types/api/openai-responses"

import { type StateSnapshot, restoreStateForTests, setModels, setStateForTests, snapshotStateForTests } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { bootstrapTestRuntime, resetTestRuntime } from "../helpers/test-bootstrap"

let capturedPayload: ResponsesPayload | undefined
const originalFetch = globalThis.fetch

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

function getCapturedInputItems() {
  expect(Array.isArray(capturedPayload?.input)).toBe(true)
  return capturedPayload?.input as Array<NonNullable<ResponsesPayload["input"]>[number]>
}

function getCapturedInputItem(index: number) {
  const item = getCapturedInputItems()[index]
  expect(typeof item).toBe("object")
  expect(item).not.toBeNull()
  return item as Extract<NonNullable<ResponsesPayload["input"]>[number], { type?: string }>
}

let responseFactory: (payload: ResponsesPayload) => Promise<Response> | Response
const upstreamFetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
  capturedPayload = JSON.parse(String(init?.body)) as ResponsesPayload
  return await responseFactory(capturedPayload)
})

const { createFullTestApp } = await import("../helpers/test-app")

const app = createFullTestApp()

describe("POST /responses", () => {
  let snapshot: StateSnapshot

  beforeAll(() => {
    bootstrapTestRuntime()
  })

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    capturedPayload = undefined
    upstreamFetchMock.mockClear()
    // responses-client.ts checks state.copilotToken before calling fetch
    setStateForTests({ copilotToken: "test-token" })
    responseFactory = (payload) => {
      if (payload.stream) {
        return createSseResponse([
          `event: response.created\ndata: ${JSON.stringify({
            type: "response.created",
            sequence_number: 0,
            response: {
              id: "resp-stream-test",
              object: "response",
              created_at: 1,
              status: "in_progress",
              model: payload.model,
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
            delta: "Hello from mocked responses stream",
          })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({
            type: "response.completed",
            sequence_number: 2,
            response: {
              id: "resp-stream-test",
              object: "response",
              created_at: 1,
              status: "completed",
              model: payload.model,
              output: [],
              usage: {
                input_tokens: 5,
                output_tokens: 3,
                total_tokens: 8,
              },
              tools: [],
              tool_choice: "auto",
              parallel_tool_calls: false,
              store: false,
            },
          })}\n\n`,
          "data: [DONE]\n\n",
        ])
      }

      return new Response(
        JSON.stringify({
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
              content: [
                {
                  type: "output_text",
                  text: "Mocked responses output",
                  annotations: [],
                },
              ],
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
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }
    globalThis.fetch = upstreamFetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreStateForTests(snapshot)
    resetTestRuntime()
  })

  test("returns 400 when the selected model does not support /responses", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("claude-sonnet-4.6", {
          vendor: "Anthropic",
          supported_endpoints: ["/v1/messages"],
        }),
      ],
    })

    const res = await app.request("/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        input: "Hello",
      }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: {
        message: 'Model "claude-sonnet-4.6" does not support the /responses endpoint',
        type: "error",
      },
    })
    expect(upstreamFetchMock).not.toHaveBeenCalled()
  })

  test("normalizes call ids before invoking the upstream responses client", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })

    const res = await app.request("/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: [
          {
            type: "function_call",
            id: "call_123",
            call_id: "call_123",
            name: "lookup_weather",
            arguments: "{\"city\":\"Paris\"}",
          },
          {
            type: "function_call_output",
            call_id: "call_123",
            output: "Sunny",
          },
        ],
      }),
    })

    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      id: "resp-http-test",
      object: "response",
      model: "gpt-4o",
    })
    expect(upstreamFetchMock).toHaveBeenCalledTimes(1)
    const functionCall = getCapturedInputItem(0)
    const functionCallOutput = getCapturedInputItem(1)
    expect(functionCall.id).toBe("fc_123")
    expect(functionCall.call_id).toBe("fc_123")
    expect(functionCallOutput.call_id).toBe("fc_123")
  })

  test("preserves call ids when normalization is disabled", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })
    setStateForTests({ normalizeResponsesCallIds: false })

    const res = await app.request("/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: [
          {
            type: "function_call",
            id: "call_999",
            call_id: "call_999",
            name: "lookup_weather",
            arguments: "{\"city\":\"Berlin\"}",
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(upstreamFetchMock).toHaveBeenCalledTimes(1)
    const functionCall = getCapturedInputItem(0)
    expect(functionCall.id).toBe("call_999")
    expect(functionCall.call_id).toBe("call_999")
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

    const res = await app.request("/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: "Stream please",
        stream: true,
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(upstreamFetchMock).toHaveBeenCalledTimes(1)
    expect(capturedPayload?.stream).toBe(true)
    expect(capturedPayload?.model).toBe("gpt-4o")
  })

  test("forwards upstream failures through the shared error handler", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })
    responseFactory = async () => {
      throw new Error("responses upstream exploded")
    }

    const res = await app.request("/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: "Hello",
      }),
    })

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: {
        type: "error",
        message: "responses upstream exploded",
      },
    })
  })
})
