/**
 * HTTP-level tests for the Gemini-compatible endpoints. Runs the real
 * `createChatCompletions` upstream client against a mocked `globalThis.fetch`
 * (process-global `mock.module` leaks into sibling test files) so the test
 * exercises:
 *   - request translation (Gemini → ChatCompletionsPayload)
 *   - pipeline reuse (model resolution, sanitize, history endpoint type)
 *   - response translation (ChatCompletionResponse → GenerateContentResponse)
 *   - streaming translation (SSE chunks)
 *   - error wire format (Gemini gRPC-shape envelope)
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
  restoreFetch,
} from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"
import {
  //
  bootstrapTestRuntime,
  resetTestRuntime,
} from "../helpers/test-bootstrap"

// ----- upstream wire mock -----
//
// The Gemini route translates the incoming request into an OpenAI
// ChatCompletionsPayload and calls the real `createChatCompletions` client,
// which hits the `/chat/completions` upstream. We route by URL suffix, capture
// the translated payload, and let individual tests swap the response shape.

let capturedPayload: ChatCompletionsPayload | undefined
let responseFactory: (payload: ChatCompletionsPayload) => Response

function buildDefaultResponse(model: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-gemini-http-test",
      object: "chat.completion",
      created: 1,
      model,
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
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function buildStreamResponse(model: string): Response {
  return createSseResponse([
    `data: ${JSON.stringify({
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
    })}\n\n`,
    `data: ${JSON.stringify({
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
    })}\n\n`,
    "data: [DONE]\n\n",
  ])
}

/**
 * SSE response that emits the given frames, then errors the stream — emulates an
 * upstream that blows up mid-stream after delivering partial content.
 */
function buildErroringStreamResponse(frames: ReadonlyArray<string>, message: string): Response {
  const encoder = new TextEncoder()
  // Pull-based: enqueue the frames on the first pulls so the SSE parser actually
  // consumes them, then error the stream on the next pull. Erroring eagerly in
  // `start()` would discard the queued frames before the consumer reads them.
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < frames.length) {
        controller.enqueue(encoder.encode(frames[index]))
        index += 1
        return
      }
      controller.error(new Error(message))
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

const upstreamFetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
  // The request layer always passes a plain string URL; narrow before matching
  // rather than String()-coercing a URL/Request into a base-stringified value.
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url

  if (url.endsWith("/chat/completions")) {
    // The request layer always serializes the JSON payload to a string body.
    if (typeof init?.body !== "string") {
      throw new TypeError(`expected string body in mock, got ${typeof init?.body}`)
    }
    capturedPayload = JSON.parse(init.body) as ChatCompletionsPayload
    return responseFactory(capturedPayload)
  }

  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")

const app = createFullTestApp()

function setDefaultResponseFactory(): void {
  responseFactory = (payload) => (payload.stream ? buildStreamResponse(payload.model) : buildDefaultResponse(payload.model))
}

function applyGeminiState(): void {
  // The real chat-completions client checks state.copilotToken before issuing fetch.
  setStateForTests({
    copilotToken: "test-token",
    accountType: "individual",
    vsCodeVersion: "1.100.0",
    fetchTimeout: 0,
  })
  applyFetchMock(upstreamFetchMock)
}

describe("POST /v1beta/models/<model>:generateContent", () => {
  let snapshot: StateSnapshot

  beforeAll(() => {
    bootstrapTestRuntime()
  })

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    capturedPayload = undefined
    upstreamFetchMock.mockClear()
    setDefaultResponseFactory()
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })
    applyGeminiState()
  })

  afterEach(() => {
    restoreFetch()
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
    expect(upstreamFetchMock).toHaveBeenCalledTimes(1)
    expect(capturedPayload?.model).toBe("gpt-4o")
    expect(capturedPayload?.messages).toHaveLength(1)
    expect(capturedPayload?.messages[0]).toEqual({ role: "user", content: "Hello Gemini" })
    expect(capturedPayload?.stream).toBe(false)
  })

  test("returns Gemini error envelope when upstream throws", async () => {
    responseFactory = () => {
      throw new Error("upstream exploded")
    }

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
    upstreamFetchMock.mockClear()
    setDefaultResponseFactory()
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })
    applyGeminiState()
  })

  afterEach(() => {
    restoreFetch()
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
    responseFactory = (payload) =>
      buildErroringStreamResponse(
        [
          `data: ${JSON.stringify({
            id: "x",
            object: "chat.completion.chunk",
            created: 1,
            model: payload.model,
            choices: [{ index: 0, delta: { content: "starting" }, finish_reason: null, logprobs: null }],
          })}\n\n`,
        ],
        "stream blew up",
      )

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
    restoreFetch()
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
    const legacyTokens = await countTextTokens(JSON.stringify({ contents: [{ role: "user", parts: [{ text: textOnly }] }] }), model)
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
    upstreamFetchMock.mockClear()
    setDefaultResponseFactory()
    setModels({
      object: "list",
      data: [
        mockModel("vendor:family:variant", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })
    applyGeminiState()
  })

  afterEach(() => {
    restoreFetch()
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
    upstreamFetchMock.mockClear()
    setDefaultResponseFactory()
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })
    applyGeminiState()
  })

  afterEach(() => {
    restoreFetch()
    restoreStateForTests(snapshot)
    resetTestRuntime()
  })

  test("partial usage survives mid-stream failure into the history entry", async () => {
    // Upstream emits one chunk with full usage metadata, then throws — the
    // history entry's recorded response should carry the partial usage
    // rather than the all-zero default fail() produces.

    responseFactory = (payload) =>
      buildErroringStreamResponse(
        [
          `data: ${JSON.stringify({
            id: "x",
            object: "chat.completion.chunk",
            created: 1,
            model: payload.model,
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop", logprobs: null }],
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
          })}\n\n`,
        ],
        "stream blew up after usage",
      )

    const { getBus } = await import("~/lib/observability")
    const captured: Array<{ usage: { input_tokens: number; output_tokens: number }; stop_reason?: string }> = []
    const unsubscribe = getBus().subscribe((evt) => {
      if (evt.kind === "request.failed") {
        const r = evt.entry.outboundResponse
        if (r) captured.push({ usage: r.usage, stop_reason: r.stop_reason })
      }
    })

    try {
      const res = await app.request("/v1beta/models/gpt-4o:streamGenerateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "go" }] }] }),
      })
      expect(res.status).toBe(200)
      await res.text()
    } finally {
      unsubscribe()
    }

    expect(captured).toHaveLength(1)
    expect(captured[0].usage.input_tokens).toBe(7)
    expect(captured[0].usage.output_tokens).toBe(3)
    expect(captured[0].stop_reason).toBe("STOP")
  })
})
