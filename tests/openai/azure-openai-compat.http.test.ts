/**
 * HTTP tests for Azure OpenAI URL compatibility.
 *
 * Verifies both classic deployment-based format:
 *   POST /openai/deployments/{model}/chat/completions?api-version=...
 * and v1 format:
 *   POST /openai/v1/chat/completions
 */

import {
  //
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type { EmbeddingRequest } from "~/lib/openai/embeddings"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import {
  //
  type StateSnapshot,
  restoreStateForTests,
  setModels,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import {
  //
  applyFetchMock,
  autoRestoreFetch,
} from "../helpers/mock-fetch"
import {
  //
  bootstrapTestRuntime,
  resetTestRuntime,
} from "../helpers/test-bootstrap"

// ----- upstream wire mock -----
//
// Instead of stubbing the client modules (process-global `mock.module` leaks
// into sibling test files), let the real `createChatCompletions` /
// `createEmbeddings` clients run against a mocked `globalThis.fetch`. We route
// by the upstream URL suffix and capture the payload from the request body so
// dispatch assertions read the wire rather than a stubbed function.

let capturedPayload: ChatCompletionsPayload | undefined
let capturedEmbeddingsPayload: EmbeddingRequest | undefined
let chatHits = 0
let embeddingsHits = 0

const upstreamFetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
  // The request layer always passes a plain string URL; narrow before matching
  // rather than String()-coercing a URL/Request into a base-stringified value.
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  // The request layer always serializes the JSON payload to a string body.

  if (url.endsWith("/chat/completions")) {
    chatHits += 1
    capturedPayload = typeof init?.body === "string" ? (JSON.parse(init.body) as ChatCompletionsPayload) : undefined
    const model = capturedPayload?.model ?? "unknown"
    return new Response(
      JSON.stringify({
        id: "chatcmpl-azure-test",
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
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }

  if (url.endsWith("/embeddings")) {
    embeddingsHits += 1
    capturedEmbeddingsPayload = typeof init?.body === "string" ? (JSON.parse(init.body) as EmbeddingRequest) : undefined
    const model = capturedEmbeddingsPayload?.model ?? "unknown"
    return new Response(
      JSON.stringify({
        object: "list",
        data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
        model,
        usage: { prompt_tokens: 2, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }

  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")

const app = createFullTestApp()

function setupChatModel() {
  setModels({
    object: "list",
    data: [
      mockModel("gpt-4o", {
        vendor: "OpenAI",
        supported_endpoints: ["/chat/completions", "/responses"],
      }),
      mockModel("claude-sonnet-4.6", {
        vendor: "Anthropic",
        supported_endpoints: ["/v1/messages"],
      }),
    ],
  })
}

// ============================================================================
// Classic deployment-based format
// ============================================================================

describe("Azure OpenAI classic deployment format", () => {
  let snapshot: StateSnapshot

  beforeAll(() => {
    bootstrapTestRuntime()
  })

  autoRestoreFetch()

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    capturedPayload = undefined
    capturedEmbeddingsPayload = undefined
    chatHits = 0
    embeddingsHits = 0
    upstreamFetchMock.mockClear()
    // The real chat-completions / embeddings clients check state.copilotToken
    // before issuing fetch.
    setStateForTests({ copilotToken: "test-token", fetchTimeout: 0 })
    applyFetchMock(upstreamFetchMock)
    setupChatModel()
  })

  afterEach(() => {
    restoreStateForTests(snapshot)
    resetTestRuntime()
  })

  test("POST /openai/deployments/{model}/chat/completions injects model from URL path", async () => {
    const res = await app.request("/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
        // No model field — should be injected from URL path
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      id: "chatcmpl-azure-test",
      model: "gpt-4o",
    })
    expect(chatHits).toBe(1)
    expect(capturedPayload?.model).toBe("gpt-4o")
  })

  test("POST /openai/deployments/{model}/chat/completions URL path overrides body model", async () => {
    const res = await app.request("/openai/deployments/gpt-4o/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "some-other-model",
        messages: [{ role: "user", content: "Hello" }],
      }),
    })

    expect(res.status).toBe(200)
    // URL path deployment-id is authoritative — body model is overwritten
    expect(capturedPayload?.model).toBe("gpt-4o")
  })

  test("api-version query parameter is ignored gracefully", async () => {
    const res = await app.request("/openai/deployments/gpt-4o/chat/completions?api-version=2025-04-01-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(capturedPayload?.model).toBe("gpt-4o")
  })

  test("returns 400 for unsupported model endpoint", async () => {
    const res = await app.request("/openai/deployments/claude-sonnet-4.6/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
      }),
    })

    expect(res.status).toBe(400)
  })

  test("POST /openai/deployments/{model}/embeddings injects model and routes to embeddings handler", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("text-embedding-3-small", {
          vendor: "OpenAI",
          supported_endpoints: ["/embeddings"],
        }),
      ],
    })

    const res = await app.request("/openai/deployments/text-embedding-3-small/embeddings?api-version=2024-10-21", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: "Hello world",
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ object: "list", model: "text-embedding-3-small" })
    expect(embeddingsHits).toBe(1)
    expect(capturedEmbeddingsPayload?.model).toBe("text-embedding-3-small")
  })
})

// ============================================================================
// Azure v1 format (standard OpenAI paths under /openai prefix)
// ============================================================================

describe("Azure OpenAI v1 format", () => {
  let snapshot: StateSnapshot

  beforeAll(() => {
    bootstrapTestRuntime()
  })

  autoRestoreFetch()

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    capturedPayload = undefined
    capturedEmbeddingsPayload = undefined
    chatHits = 0
    embeddingsHits = 0
    upstreamFetchMock.mockClear()
    setStateForTests({ copilotToken: "test-token", fetchTimeout: 0 })
    applyFetchMock(upstreamFetchMock)
    setupChatModel()
  })

  afterEach(() => {
    restoreStateForTests(snapshot)
    resetTestRuntime()
  })

  test("POST /openai/v1/chat/completions routes to chat completions handler", async () => {
    const res = await app.request("/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello from v1" }],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      id: "chatcmpl-azure-test",
      model: "gpt-4o",
    })
    expect(capturedPayload?.model).toBe("gpt-4o")
  })

  test("GET /openai/v1/models returns model list", async () => {
    const res = await app.request("/openai/v1/models")

    expect(res.status).toBe(200)
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> }
    expect(body.object).toBe("list")
    expect(body.data.length).toBeGreaterThan(0)
  })

  test("GET /openai/v1/models/:model returns single model", async () => {
    const res = await app.request("/openai/v1/models/gpt-4o")

    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string }
    expect(body.id).toBe("gpt-4o")
  })

  test("POST /openai/v1/embeddings routes to embeddings handler", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("text-embedding-3-small", {
          vendor: "OpenAI",
          supported_endpoints: ["/embeddings"],
        }),
      ],
    })

    const res = await app.request("/openai/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: "Hello from v1",
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ object: "list", model: "text-embedding-3-small" })
    expect(embeddingsHits).toBe(1)
  })
})
