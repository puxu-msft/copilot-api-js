/**
 * C0 golden pre-capture (c-gemini) — Gemini via-responses STREAMING two-hop TERMINAL byte golden.
 *
 * A Gemini client (`:streamGenerateContent`) routed to a Responses-only model runs the TWO-HOP bridge:
 *   request:  Gemini → CC → Responses wire (upstream `/responses`, streaming)
 *   response: upstream Responses SSE → Responses→CC per-frame (renderResponsesFrameToCc + createStreamTranslator)
 *             → CC→Gemini per-frame → forwarded Gemini SSE
 *
 * WHY this is missing (RFC §0.1 / C0-c): the existing gemini via-responses byte golden (gemini-v4:242) is
 * NON-streaming. There is NO streaming two-hop TERMINAL byte golden. C4/HIGH-1 EXTRACTS the Responses→CC
 * per-frame primitive (`renderResponsesFrameToCc` + `createStreamTranslator`) out of the openai-cc codec into
 * the hub so the gemini InboundCodec can hold the intermediate translator state independently — this golden
 * locks the exact forwarded Gemini SSE (esp. the terminal usageMetadata frame) so that extraction stays
 * byte-identical.
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

import { getHistory } from "~/lib/history"
import {
  //
  setDisabledModels,
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"

/** Upstream Responses SSE (streaming): created → text delta → completed (with usage). */
function responsesStreamFrames(model: string): Array<string> {
  return [
    `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_c0c", model } })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hi from responses" })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_c0c", model, usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } })}\n\n`,
  ]
}

let lastResponsesWire: { model?: string; input?: unknown; stream?: boolean } | undefined

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? JSON.parse(init.body) : {}
  if (url.endsWith("/responses")) {
    lastResponsesWire = payload as { model?: string; input?: unknown; stream?: boolean }
    if (payload.stream) return Promise.resolve(createSseResponse(responsesStreamFrames(payload.model)))
    throw new Error("expected a streaming /responses request in this golden")
  }
  throw new Error(`unexpected upstream URL: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

function injectModels(): void {
  setDisabledModels([])
  setModels({ object: "list", data: [mockModel("gpt-resp-only", { vendor: "OpenAI", supported_endpoints: ["/responses"] })] })
}

describe("C0 golden (c-gemini) — via-responses streaming two-hop terminal bytes", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    lastResponsesWire = undefined
    applyFetchMock(upstreamFetchMock)
    setStateForTests({ copilotToken: "tok" })
  })

  afterEach(() => {})

  test("gemini :streamGenerateContent via Responses → forwarded Gemini SSE byte-locked (incl. terminal usage)", async () => {
    injectModels()
    const res = await app.request("/v1beta/models/gpt-resp-only:streamGenerateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "c0-gemini-via-resp" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()

    // ── BYTE GOLDEN: forwarded Gemini SSE for the two-hop (Responses upstream → Responses→CC→Gemini render) ──
    // text delta frame, then the terminal frame carrying finishReason:STOP + usageMetadata. No epoch to
    // normalize (Gemini frames carry no timestamp). This locks the C4/HIGH-1 hub-extracted Responses→CC
    // per-frame primitive end-to-end.
    const frame = (inner: string): string => `data: {"candidates":[${inner}],"modelVersion":"gpt-resp-only"}\n\n`
    const expected =
      frame('{"content":{"role":"model","parts":[{"text":"Hi from responses"}]},"index":0}')
      + `data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3,"totalTokenCount":10},"modelVersion":"gpt-resp-only"}\n\n`
    expect(text).toBe(expected)

    // Cross-check invariants the byte golden encodes:
    expect(text).toContain('"text":"Hi from responses"') //                    the Responses text delta survived both hops
    expect(text).toContain('"finishReason":"STOP"') //                         terminal finishReason
    expect(text).toContain('"promptTokenCount":7,"candidatesTokenCount":3') // the Responses usage mapped to Gemini usageMetadata
    expect(lastResponsesWire?.stream).toBe(true) // the two-hop wire was Responses-shaped + streaming

    const entry = getHistory({ endpoint: "gemini-generate-content", sessionId: "c0-gemini-via-resp", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
  })
})
