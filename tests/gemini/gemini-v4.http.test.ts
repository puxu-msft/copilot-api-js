/**
 * P2.5 — Gemini v4 driver ↔ legacy equivalence (http).
 *
 * Runs the same Gemini request through the legacy handler (flag off) and the v4
 * driver path (flag on) against the same mocked upstream, asserting the client-
 * facing Gemini output + the outbound CC wire payload match. Covers
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

import {
  //
  isV4DriverEnabled,
  setV4DriverEnabled,
} from "~/lib/codec/driver-flags"
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

const DEFAULT_V4_FLAG = isV4DriverEnabled("gemini")

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

let errorMidStream = false

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? JSON.parse(init.body) : {}

  if (url.endsWith("/chat/completions")) {
    lastCcWire = payload as ChatCompletionsPayload
    if (errorMidStream) return Promise.resolve(erroringCcStream(payload.model))
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

describe("Gemini v4 ↔ legacy equivalence", () => {
  autoTestRuntime()
  autoRestoreFetch()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    lastCcWire = undefined
    lastResponsesWire = undefined
    errorMidStream = false
    applyFetchMock(upstreamFetchMock)
    setStateForTests({ copilotToken: "tok", autoTruncate: false })
  })

  afterEach(() => {
    setV4DriverEnabled("gemini", DEFAULT_V4_FLAG)
  })

  test("generateContent non-streaming: client Gemini json + CC wire equal", async () => {
    const body = { contents: [{ role: "user", parts: [{ text: "Hello Gemini" }] }] }

    setV4DriverEnabled("gemini", false)
    const legacy = (await (await post("gpt-4o:generateContent", body)).json()) as Record<string, unknown>
    const legacyWire = lastCcWire

    setV4DriverEnabled("gemini", true)
    const v4 = (await (await post("gpt-4o:generateContent", body)).json()) as Record<string, unknown>
    const v4Wire = lastCcWire

    expect(v4).toEqual(legacy)
    expect(v4Wire).toEqual(legacyWire)
    // Gemini-shape sanity
    expect((v4 as { candidates: Array<{ content: { role: string } }> }).candidates[0].content.role).toBe("model")
  })

  test("streamGenerateContent: client Gemini SSE equal", async () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }

    setV4DriverEnabled("gemini", false)
    const legacyText = await (await post("gpt-4o:streamGenerateContent", body)).text()

    setV4DriverEnabled("gemini", true)
    const v4Text = await (await post("gpt-4o:streamGenerateContent", body)).text()

    expect(v4Text).toBe(legacyText)
    expect(v4Text).toContain("usageMetadata")
  })

  test("via-responses: Gemini→CC→Responses, wire is Responses-shaped, client Gemini json equal", async () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }

    setV4DriverEnabled("gemini", false)
    const legacy = (await (await post("gpt-resp-only:generateContent", body)).json()) as Record<string, unknown>
    const legacyWire = lastResponsesWire

    setV4DriverEnabled("gemini", true)
    const v4 = (await (await post("gpt-resp-only:generateContent", body)).json()) as Record<string, unknown>
    const v4Wire = lastResponsesWire

    expect(v4).toEqual(legacy)
    expect(v4Wire?.input).toBeDefined() // CC→Responses translation happened
    expect(v4Wire).toEqual(legacyWire)
  })

  test("mid-stream error: Gemini-shape data-only error frame equal", async () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }

    setV4DriverEnabled("gemini", false)
    errorMidStream = true
    const legacyText = await (await post("gpt-4o:streamGenerateContent", body)).text()

    setV4DriverEnabled("gemini", true)
    errorMidStream = true
    const v4Text = await (await post("gpt-4o:streamGenerateContent", body)).text()

    expect(v4Text).toBe(legacyText)
    expect(v4Text).toContain("upstream blew up")
    expect(v4Text).toContain("INTERNAL")
  })

  test("dropped-params warning recorded on both paths (safetySettings)", async () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }], safetySettings: [{ category: "HARM", threshold: "BLOCK_NONE" }] }

    setV4DriverEnabled("gemini", false)
    await post("gpt-4o:generateContent", body)
    const legacyWarn = getHistory({ endpoint: "gemini-generate-content" }).entries[0]?.warningMessages?.some(
      (w: { code: string }) => w.code === "gemini_dropped_params",
    )

    setV4DriverEnabled("gemini", true)
    await post("gpt-4o:generateContent", body)
    const v4Warn = getHistory({ endpoint: "gemini-generate-content" }).entries[0]?.warningMessages?.some(
      (w: { code: string }) => w.code === "gemini_dropped_params",
    )

    expect(legacyWarn).toBe(true)
    expect(v4Warn).toBe(true)
  })

  test("history double-track (L2): effective + outbound openai-chat-completions, equal to legacy", async () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }

    setV4DriverEnabled("gemini", false)
    await post("gpt-4o:generateContent", body)
    const legacy = getHistory({ endpoint: "gemini-generate-content" }).entries[0]

    setV4DriverEnabled("gemini", true)
    await post("gpt-4o:generateContent", body)
    const v4 = getHistory({ endpoint: "gemini-generate-content" }).entries[0]

    expect(v4?.effectiveRequest?.format).toBe(legacy?.effectiveRequest?.format)
    expect(v4?.effectiveRequest?.format).toBe("openai-chat-completions")
    expect(v4?.outboundRequest?.format).toBe("openai-chat-completions")
    expect(v4?.outboundRequest?.messageCount).toBe(legacy?.outboundRequest?.messageCount)
    expect(typeof v4?.queueWaitMs).toBe("number")
  })

  test("history: non-streaming success finalizes the entry (completed) on both paths", async () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] }

    setV4DriverEnabled("gemini", false)
    await post("gpt-4o:generateContent", body)
    const legacyState = getHistory({ endpoint: "gemini-generate-content" }).entries[0]?.state

    setV4DriverEnabled("gemini", true)
    await post("gpt-4o:generateContent", body)
    const v4State = getHistory({ endpoint: "gemini-generate-content" }).entries[0]?.state

    expect(legacyState).toBe("completed")
    expect(v4State).toBe("completed")
  })
})
