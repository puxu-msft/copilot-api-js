/**
 * HTTP-level tests for the Gemini-compatible endpoints. Mocks the underlying
 * `createChatCompletions` upstream call so the test exercises:
 *   - request translation (Gemini → ChatCompletionsPayload)
 *   - pipeline reuse (model resolution, sanitize, history endpoint type)
 *   - response translation (ChatCompletionResponse → GenerateContentResponse)
 *   - streaming translation (SSE chunks)
 *   - error wire format (Gemini gRPC-shape envelope)
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

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

import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { prepareChatCompletionsRequest } from "~/lib/openai/request-preparation"
import {
  //
  type StateSnapshot,
  restoreStateForTests,
  setModels,
  snapshotStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import {
  //
  bootstrapTestRuntime,
  resetTestRuntime,
} from "../helpers/test-bootstrap"

let capturedPayload: ChatCompletionsPayload | undefined

const createChatCompletionsMock = mock(async (payload: ChatCompletionsPayload) => {
  capturedPayload = payload

  if (payload.stream) {
    return createMockChatStream(payload.model)
  }

  return {
    id: "chatcmpl-gemini-http-test",
    object: "chat.completion",
    created: 1,
    model: payload.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Mocked Gemini response" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
    },
  }
})

function createMockChatStream(model: string): AsyncGenerator<ServerSentEventMessage> {
  return (async function* () {
    yield {
      data: JSON.stringify({
        id: "chatcmpl-gemini-stream",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Hello " },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
    }
    yield {
      data: JSON.stringify({
        id: "chatcmpl-gemini-stream",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [
          {
            index: 0,
            delta: { content: "Gemini" },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    }
    yield { data: "[DONE]" }
  })()
}

mock.module("~/lib/openai/chat-completions-client", () => ({
  createChatCompletions: createChatCompletionsMock,
  prepareChatCompletionsRequest,
}))

const { createFullTestApp } = await import("../helpers/test-app")

const app = createFullTestApp()

describe("POST /v1beta/models/<model>:generateContent", () => {
  let snapshot: StateSnapshot

  beforeAll(() => {
    bootstrapTestRuntime()
  })

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    capturedPayload = undefined
    createChatCompletionsMock.mockClear()
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

  test("returns Gemini-shaped response and forwards translated OpenAI payload", async () => {
    const res = await app.request("/v1beta/models/gpt-4o:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hello Gemini" }] }],
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      candidates: Array<{ content: { parts: Array<{ text: string }>; role: string }; finishReason: string }>
      modelVersion: string
      usageMetadata: { promptTokenCount: number; candidatesTokenCount: number }
    }
    expect(body.candidates[0].content.role).toBe("model")
    expect(body.candidates[0].content.parts[0].text).toBe("Mocked Gemini response")
    expect(body.candidates[0].finishReason).toBe("STOP")
    expect(body.modelVersion).toBe("gpt-4o")
    expect(body.usageMetadata.promptTokenCount).toBe(12)
    expect(body.usageMetadata.candidatesTokenCount).toBe(4)

    // Translation forwarded the right OpenAI payload to upstream
    expect(createChatCompletionsMock).toHaveBeenCalledTimes(1)
    expect(capturedPayload?.model).toBe("gpt-4o")
    expect(capturedPayload?.messages).toHaveLength(1)
    expect(capturedPayload?.messages[0]).toEqual({ role: "user", content: "Hello Gemini" })
    expect(capturedPayload?.stream).toBe(false)
  })

  test("returns Gemini error envelope when upstream throws", async () => {
    createChatCompletionsMock.mockImplementationOnce(async () => {
      throw new Error("upstream exploded")
    })

    const res = await app.request("/v1beta/models/gpt-4o:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      }),
    })

    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { status: string; code: number; message: string } }
    expect(body.error.code).toBe(500)
    expect(body.error.status).toBe("INTERNAL")
    expect(body.error.message).toContain("upstream exploded")
  })

  test("rejects unknown :method with NOT_FOUND in Gemini envelope", async () => {
    const res = await app.request("/v1beta/models/gpt-4o:bogus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [] }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { status: string } }
    expect(body.error.status).toBe("NOT_FOUND")
  })
})

describe("POST /v1beta/models/<model>:streamGenerateContent", () => {
  let snapshot: StateSnapshot

  beforeAll(() => {
    bootstrapTestRuntime()
  })

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    capturedPayload = undefined
    createChatCompletionsMock.mockClear()
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

  test("returns SSE stream of Gemini-shaped frames", async () => {
    const res = await app.request("/v1beta/models/gpt-4o:streamGenerateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "stream this" }] }],
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(capturedPayload?.stream).toBe(true)

    const text = await res.text()
    // Each SSE event starts with `data: ` and ends with two newlines.
    const dataLines = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((l) => l.slice(6))
    expect(dataLines.length).toBeGreaterThanOrEqual(2)

    // First frame must be a valid Gemini-shaped chunk with text
    const first = JSON.parse(dataLines[0]) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>
    }
    expect(first.candidates[0].content.parts[0].text).toBe("Hello ")

    // Final frame must carry finishReason + usageMetadata
    const last = JSON.parse(dataLines.at(-1) ?? "{}") as {
      candidates: Array<{ finishReason: string }>
      usageMetadata: { promptTokenCount: number }
    }
    expect(last.candidates[0].finishReason).toBe("STOP")
    expect(last.usageMetadata.promptTokenCount).toBe(3)
  })

  test("stream error surfaces as a data-only Gemini-shape frame (no event: name)", async () => {
    createChatCompletionsMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield {
          data: JSON.stringify({
            id: "x",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-4o",
            choices: [{ index: 0, delta: { content: "starting" }, finish_reason: null, logprobs: null }],
          }),
        }
        throw new Error("stream blew up")
      })()
    })

    const res = await app.request("/v1beta/models/gpt-4o:streamGenerateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "go" }] }] }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    // Must NOT contain a named "event: error" frame — real Gemini SDK clients
    // ignore named events and would silently swallow the error.
    expect(text).not.toContain("event: error")
    const dataLines = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((l) => l.slice(6))
    expect(dataLines.length).toBeGreaterThanOrEqual(2)
    const errorFrame = JSON.parse(dataLines.at(-1) ?? "{}") as {
      candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>
      error?: { code?: number; status?: string }
    }
    expect(errorFrame.candidates?.[0].finishReason).toBe("OTHER")
    expect(errorFrame.candidates?.[0].content?.parts?.[0].text).toContain("stream blew up")
    expect(errorFrame.error?.status).toBe("INTERNAL")
  })
})

describe("POST /v1beta/models/<model>:countTokens", () => {
  let snapshot: StateSnapshot

  beforeAll(() => {
    bootstrapTestRuntime()
  })

  beforeEach(() => {
    snapshot = snapshotStateForTests()
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

  test("returns totalTokens for a simple prompt", async () => {
    const res = await app.request("/v1beta/models/gpt-4o:countTokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hello world" }] }],
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { totalTokens: number; cachedContentTokenCount?: number }
    expect(body.totalTokens).toBeGreaterThan(0)
    expect(body.cachedContentTokenCount).toBeUndefined()
  })

  test("includes cachedContentTokenCount placeholder when cachedContent is provided", async () => {
    const res = await app.request("/v1beta/models/gpt-4o:countTokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        cachedContent: "cached/abc",
      }),
    })
    const body = (await res.json()) as { totalTokens: number; cachedContentTokenCount?: number }
    expect(body.cachedContentTokenCount).toBe(0)
  })

  test("returns 404 in Gemini envelope when model is unknown", async () => {
    const res = await app.request("/v1beta/models/no-such-model:countTokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [] }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { status: string; code: number } }
    expect(body.error.status).toBe("NOT_FOUND")
    expect(body.error.code).toBe(404)
  })

  test("M-new-3: counts only text — not JSON wire keys / braces", async () => {
    // The legacy `JSON.stringify(body)` estimator counted braces / quotes /
    // field names like "contents", "parts", "role". A text-only estimator
    // must be strictly smaller (typically 2–4× smaller) for the same prompt.
    const textOnly = "hello world this is some text that should be the only thing counted"

    const res = await app.request("/v1beta/models/gpt-4o:countTokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: textOnly }] }],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { totalTokens: number }

    // Compute what the legacy JSON-blob estimator would have produced.
    const { countTextTokens } = await import("~/lib/models/tokenizer")
    const { state: liveState } = await import("~/lib/state")
    const model = liveState.modelIndex.get("gpt-4o")
    if (!model) throw new Error("gpt-4o missing from test fixture")
    const legacyTokens = await countTextTokens(
      JSON.stringify({ contents: [{ role: "user", parts: [{ text: textOnly }] }] }),
      model,
    )
    const textOnlyTokens = await countTextTokens(textOnly, model)

    expect(body.totalTokens).toBe(textOnlyTokens)
    expect(body.totalTokens).toBeLessThan(legacyTokens)
  })

  test("M-new-3: walks generateContentRequest.contents + systemInstruction too", async () => {
    const res = await app.request("/v1beta/models/gpt-4o:countTokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        generateContentRequest: {
          systemInstruction: { parts: [{ text: "be terse" }] },
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        },
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { totalTokens: number }
    expect(body.totalTokens).toBeGreaterThan(0)

    // Compare with a body that only has the system instruction text — wrapping
    // path must still contribute tokens.
    const baseline = await app.request("/v1beta/models/gpt-4o:countTokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        generateContentRequest: {
          systemInstruction: { parts: [{ text: "be terse" }] },
          contents: [],
        },
      }),
    })
    const baselineBody = (await baseline.json()) as { totalTokens: number }
    expect(body.totalTokens).toBeGreaterThan(baselineBody.totalTokens)
  })
})

describe("Gemini route :method parsing (L-new-1)", () => {
  let snapshot: StateSnapshot

  beforeAll(() => {
    bootstrapTestRuntime()
  })

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    capturedPayload = undefined
    createChatCompletionsMock.mockClear()
    setModels({
      object: "list",
      data: [
        mockModel("vendor:family:variant", {
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

  test("model ids containing colons dispatch correctly (last `:` is the method delimiter)", async () => {
    // Pre-fix, `indexOf(':')` would split "vendor:family:variant:generateContent"
    // into model="vendor" / method="family:variant:generateContent" → 404.
    const res = await app.request("/v1beta/models/vendor:family:variant:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      }),
    })
    expect(res.status).toBe(200)
    expect(capturedPayload?.model).toBe("vendor:family:variant")
  })
})

describe("Gemini streaming partial usage (L-new-2)", () => {
  let snapshot: StateSnapshot

  beforeAll(() => {
    bootstrapTestRuntime()
  })

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    capturedPayload = undefined
    createChatCompletionsMock.mockClear()
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

  test("partial usage survives mid-stream failure into the history entry", async () => {
    // Upstream emits one chunk with full usage metadata, then throws — the
    // history entry's recorded response should carry the partial usage
    // rather than the all-zero default fail() produces.

    createChatCompletionsMock.mockImplementationOnce(async () => {
      return (async function* () {
        yield {
          data: JSON.stringify({
            id: "x",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt-4o",
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop", logprobs: null }],
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
          }),
        }
        throw new Error("stream blew up after usage")
      })()
    })

    const { getRequestContextManager } = await import("~/lib/context/manager")
    const captured: Array<{ usage: { input_tokens: number; output_tokens: number }; stop_reason?: string }> = []
    const listener = (evt: { type: string; entry?: { response?: unknown } }): void => {
      if (evt.type === "failed" && evt.entry) {
        const r = evt.entry.response as
          | { usage: { input_tokens: number; output_tokens: number }; stop_reason?: string }
          | undefined
        if (r) captured.push({ usage: r.usage, stop_reason: r.stop_reason })
      }
    }
    getRequestContextManager().on("change", listener)

    try {
      const res = await app.request("/v1beta/models/gpt-4o:streamGenerateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "go" }] }] }),
      })
      expect(res.status).toBe(200)
      await res.text()
    } finally {
      getRequestContextManager().off("change", listener)
    }

    expect(captured).toHaveLength(1)
    expect(captured[0].usage.input_tokens).toBe(7)
    expect(captured[0].usage.output_tokens).toBe(3)
    expect(captured[0].stop_reason).toBe("STOP")
  })
})
