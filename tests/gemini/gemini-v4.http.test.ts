/**
 * Gemini v4 driver behavior (http).
 *
 * Originally a v4↔legacy equivalence suite; after P3.3 deleted the legacy Gemini
 * handler (and the `driver-flags` toggle), these assert the v4 driver path
 * directly. Byte-critical translation cases keep a golden lock captured from the
 * driver path; the rest keep their own absolute/content assertions. Covers
 * generateContent (non-streaming), streamGenerateContent, the via-responses
 * bridge (Gemini→CC→Responses), the Gemini-shape mid-stream error frame, the
 * dropped-params warning, and the L2 history double-track.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { getHistory } from "~/lib/history"
import {
  //
  setDisabledModels,
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

let lastCcWire: ChatCompletionsPayload | undefined
let lastResponsesWire: { model?: string; input?: unknown } | undefined

function ccNonStream(model: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-g",
      object: "chat.completion",
      created: 1,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "Mocked Gemini response" }, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function ccStreamFrames(model: string): Array<string> {
  return [
    `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "Hello " }, finish_reason: null, logprobs: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: "Gemini" }, finish_reason: "stop", logprobs: null }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
    "data: [DONE]\n\n",
  ]
}

function responsesStreamFrames(): Array<string> {
  return [
    `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", model: "gpt-resp-only" } })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hi" })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", model: "gpt-resp-only", usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } })}\n\n`,
  ]
}

/**
 * Stage B B0 baseline: a CC tool-call stream whose terminal frame's finish_reason
 * is "stop" (NOT "tool_calls"), so the per-frame tool drain never fires and the
 * accumulated tool_call is flushed at STREAM END (convert-stream.ts:162). This is
 * B5's hardest path — the per-frame translator's stream-end drain — which Stage B's
 * Gemini per-frame migration must reproduce. The text delta precedes the tool to
 * also lock text/tool interleave ordering.
 */
function ccToolFinishOmittedStream(model: string): Array<string> {
  return [
    `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "looking up " }, finish_reason: null, logprobs: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_w", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null, logprobs: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"SF"}' } }] }, finish_reason: null, logprobs: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`,
    "data: [DONE]\n\n",
  ]
}

let errorMidStream = false
let toolFinishOmitted = false

/** A stream that errors mid-way after delivering one frame. */
function erroringCcStream(model: string): Response {
  const encoder = new TextEncoder()
  const frames = [
    `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null, logprobs: null }] })}\n\n`,
  ]
  let i = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) {
        controller.enqueue(encoder.encode(frames[i]))
        i += 1
        return
      }
      controller.error(new Error("upstream blew up"))
    },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? JSON.parse(init.body) : {}

  if (url.endsWith("/chat/completions")) {
    lastCcWire = payload as ChatCompletionsPayload
    if (errorMidStream) return Promise.resolve(erroringCcStream(payload.model))
    if (toolFinishOmitted) return Promise.resolve(createSseResponse(ccToolFinishOmittedStream(payload.model)))
    if (payload.stream) return Promise.resolve(createSseResponse(ccStreamFrames(payload.model)))
    return Promise.resolve(ccNonStream(payload.model))
  }
  if (url.endsWith("/responses")) {
    lastResponsesWire = payload as { model?: string; input?: unknown }
    if (payload.stream) return Promise.resolve(createSseResponse(responsesStreamFrames()))
    return Promise.resolve(
      new Response(
        JSON.stringify({ id: "resp_1", model: payload.model, status: "completed", output: [], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    )
  }
  throw new Error(`unexpected upstream URL: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

function injectModels(): void {
  setDisabledModels([])
  setModels({
    object: "list",
    data: [
      mockModel("gpt-4o", { vendor: "OpenAI", supported_endpoints: ["/chat/completions", "/responses"] }),
      mockModel("gpt-resp-only", { vendor: "OpenAI", supported_endpoints: ["/responses"] }),
    ],
  })
}

async function post(modelMethod: string, body: unknown): Promise<Response> {
  injectModels()
  return app.request(`/v1beta/models/${modelMethod}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
}

describe("Gemini v4 driver path", () => {
  autoTestRuntime()
  autoRestoreFetch()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    lastCcWire = undefined
    lastResponsesWire = undefined
    errorMidStream = false
    toolFinishOmitted = false
    applyFetchMock(upstreamFetchMock)
    setStateForTests({ copilotToken: "tok", autoTruncate: false })
  })

  afterEach(() => {
    // Nothing global to restore now that the driver flag is gone.
  })

  test("generateContent non-streaming: client Gemini json + CC wire", async () => {
    const body = { contents: [{ role: "user", parts: [{ text: "Hello Gemini" }] }] }

    const v4 = (await (await post("gpt-4o:generateContent", body)).json()) as Record<string, unknown>
    const v4Wire = lastCcWire

    // Byte-lock: Gemini→CC wire + CC→Gemini rendered client json (translation path).
    expect(v4).toEqual({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Mocked Gemini response" }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
      modelVersion: "gpt-4o",
      responseId: "chatcmpl-g",
    })
    expect(v4Wire?.model).toBe("gpt-4o")
    expect(v4Wire?.messages).toEqual([{ role: "user", content: "Hello Gemini" }])
    // Gemini-shape sanity
    expect((v4 as { candidates: Array<{ content: { role: string } }> }).candidates[0].content.role).toBe("model")
  })

  test("streamGenerateContent: client Gemini SSE", async () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }

    const v4Text = await (await post("gpt-4o:streamGenerateContent", body)).text()

    // Byte-lock on the CC→Gemini stream translation (golden = translated client SSE;
    // no synthesized epoch to normalize — Gemini frames carry no timestamp).
    const frame = (inner: string): string => `data: {"candidates":[${inner}],"modelVersion":"gpt-4o"}\n\n`
    expect(v4Text).toBe(
      frame('{"content":{"role":"model","parts":[{"text":"Hello "}]},"index":0}')
        + frame('{"content":{"role":"model","parts":[{"text":"Gemini"}]},"index":0}')
        + `data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5},"modelVersion":"gpt-4o"}\n\n`,
    )
  })

  // Stage B B0 baseline: B5's hardest path — the CC→Gemini per-frame translator's
  // STREAM-END tool drain. The tool_call's terminal finish_reason is "stop" (not
  // "tool_calls"), so the per-frame drain never fires and the accumulated tool is
  // flushed at stream end (convert-stream.ts:162). Locks: text precedes tool, the
  // functionCall is emitted (id+name+args), and the terminal usageMetadata frame.
  // Stage B's Gemini per-frame migration (B5) must reproduce this byte-for-byte.
  test("Stage B B0: gemini tool-call drained at STREAM END (finish_reason omitted) + text/tool interleave", async () => {
    toolFinishOmitted = true
    const v4Text = await (await post("gpt-4o:streamGenerateContent", { contents: [{ role: "user", parts: [{ text: "weather?" }] }] })).text()

    expect(v4Text).toBe(
      `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"looking up "}]},"index":0}],"modelVersion":"gpt-4o"}\n\n`
        + `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"call_w","name":"get_weather","args":{"city":"SF"}}}]},"index":0}],"modelVersion":"gpt-4o"}\n\n`
        + `data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3,"totalTokenCount":8},"modelVersion":"gpt-4o"}\n\n`,
    )
  })

  test("via-responses: Gemini→CC→Responses, wire is Responses-shaped, client Gemini json", async () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }

    const v4 = (await (await post("gpt-resp-only:generateContent", body)).json()) as Record<string, unknown>
    const v4Wire = lastResponsesWire

    // Byte-lock: the full Gemini→CC→Responses bridge round-trip rendered back to Gemini.
    expect(v4).toEqual({
      candidates: [
        {
          content: { role: "model", parts: [] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
      modelVersion: "gpt-resp-only",
      responseId: "resp_1",
    })
    expect(v4Wire?.input).toBeDefined() // CC→Responses translation happened
  })

  test("mid-stream error: Gemini-shape data-only error frame", async () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }

    errorMidStream = true
    const v4Text = await (await post("gpt-4o:streamGenerateContent", body)).text()

    expect(v4Text).toContain("upstream blew up")
    expect(v4Text).toContain("INTERNAL")
  })

  test("dropped-params warning recorded (safetySettings)", async () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }], safetySettings: [{ category: "HARM", threshold: "BLOCK_NONE" }] }

    await post("gpt-4o:generateContent", body)
    const v4Warn = getHistory({ endpoint: "gemini-generate-content" }).entries[0]?.warningMessages?.some(
      (w: { code: string }) => w.code === "gemini_dropped_params",
    )

    expect(v4Warn).toBe(true)
  })

  test("history double-track (L2): effective + outbound openai-chat-completions", async () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }

    await post("gpt-4o:generateContent", body)
    const v4 = getHistory({ endpoint: "gemini-generate-content" }).entries[0]

    expect(v4?.effectiveRequest?.format).toBe("openai-chat-completions")
    expect(v4?.outboundRequest?.format).toBe("openai-chat-completions")
    expect(v4?.outboundRequest?.messageCount).toBe(1)
    expect(typeof v4?.queueWaitMs).toBe("number")
  })

  test("history: non-streaming success finalizes the entry (completed)", async () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }

    await post("gpt-4o:generateContent", body)
    const v4State = getHistory({ endpoint: "gemini-generate-content" }).entries[0]?.state

    expect(v4State).toBe("completed")
  })
})
