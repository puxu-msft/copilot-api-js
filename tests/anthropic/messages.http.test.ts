import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import {
  //
  setModelOverrides,
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
// Instead of stubbing `~/lib/anthropic/client` (process-global `mock.module`
// leaks into sibling test files that exercise the real client), let the real
// `createAnthropicMessages` run against a mocked `globalThis.fetch`. We route by
// the upstream URL suffix (`/v1/messages`), count hits, and capture the
// serialized payload so dispatch assertions read the wire rather than a stubbed
// function.

let messagesHits = 0
let capturedPayload: { model?: string; stream?: boolean; messages?: Array<unknown> } | undefined
let throwNextOnce = false

/** Anthropic non-streaming message body the real client returns verbatim via `response.json()`. */
function buildNonStreamingBody(model: string): string {
  return JSON.stringify({
    id: "msg-http-test",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Mocked anthropic response",
      },
    ],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 9,
      output_tokens: 4,
    },
  })
}

/** Raw SSE frames the real client converts into a generator on the streaming path. */
function buildStreamingFrames(model: string): Array<string> {
  return [
    `event: message_start\ndata: ${JSON.stringify({
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
    })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "text",
        text: "",
      },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: "Hello from mocked stream",
      },
    })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: 0,
    })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: {
        stop_reason: "end_turn",
        stop_sequence: null,
      },
      usage: {
        output_tokens: 6,
      },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({
      type: "message_stop",
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
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string; stream?: boolean; messages?: Array<unknown> }) : {}

  if (url.endsWith("/v1/messages")) {
    messagesHits += 1
    capturedPayload = payload
    if (throwNextOnce) {
      throwNextOnce = false
      throw new Error("anthropic upstream exploded")
    }
    const model = payload.model ?? "unknown"
    if (payload.stream) {
      return createSseResponse(buildStreamingFrames(model))
    }
    return new Response(buildNonStreamingBody(model), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

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
  autoTestRuntime()
  autoRestoreFetch()

  beforeEach(() => {
    messagesHits = 0
    capturedPayload = undefined
    throwNextOnce = false
    upstreamFetchMock.mockClear()
    // The real anthropic client checks state.copilotToken before issuing fetch.
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      fetchTimeout: 0,
    })
    applyFetchMock(upstreamFetchMock)
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
    expect(messagesHits).toBe(0)
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
    // Short alias "opus" resolves only via model_overrides now.
    setModelOverrides({ opus: "claude-opus-4.6" })

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
    expect(messagesHits).toBe(1)
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
    expect(messagesHits).toBe(1)
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
    throwNextOnce = true

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

  test("POST /anthropic/v1/messages alias reaches the same handler", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("claude-sonnet-4.6", {
          vendor: "Anthropic",
          supported_endpoints: ["/v1/messages"],
        }),
      ],
    })

    const res = await app.request("/anthropic/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        messages: [{ role: "user", content: "Hello via /anthropic alias" }],
        max_tokens: 32,
        stream: false,
      }),
    })

    const body = (await res.json()) as MessagesHttpBody

    expect(res.status).toBe(200)
    expect(body.id).toBe("msg-http-test")
    expect(body.model).toBe("claude-sonnet-4.6")
    expect(messagesHits).toBe(1)
    expect(capturedPayload?.model).toBe("claude-sonnet-4.6")
  })
})
