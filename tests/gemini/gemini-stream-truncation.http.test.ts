/**
 * Upstream stream truncation detection — Gemini path.
 *
 * Gemini translates an upstream CC stream. A complete stream carries a real
 * finishReason; when the upstream CC stream sends content then closes WITHOUT a
 * finish_reason, the codec meta defaults to FINISH_REASON_UNSPECIFIED. The proxy
 * must settle FAILED and emit a Gemini error frame instead of the (misleading)
 * UNSPECIFIED terminal flush.
 *
 * See docs/rfc/upstream-stream-truncation-detection.md.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import { getHistory } from "~/lib/history/store"
import { setModels } from "~/lib/models/cache"
import {
  //
  setDisabledModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"

const MODEL = "gpt-4o"

// Truncated upstream CC: a content delta, then EOF. NO finish_reason chunk.
function ccTruncatedFrames(model: string): Array<string> {
  return [
    `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null, logprobs: null }] })}\n\n`,
    // EOF — no finish_reason chunk.
  ]
}

// Truncated upstream CC where a COMPLETE tool-call (valid args) arrived before the cutoff, but no
// `tool_calls` finish_reason. The Gemini translator buffers tool-calls to flush; on truncation the
// proxy must still forward the buffered functionCall (don't drop valid content), then the error frame.
let truncatedToolCall = false
function ccTruncatedToolCallFrames(model: string): Array<string> {
  return [
    `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null, logprobs: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"SF"}' } }] }, finish_reason: null, logprobs: null }] })}\n\n`,
    // EOF — args complete, but NO `tool_calls` finish_reason chunk.
  ]
}

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
  if (url.endsWith("/chat/completions")) {
    return Promise.resolve(createSseResponse((truncatedToolCall ? ccTruncatedToolCallFrames : ccTruncatedFrames)(payload.model ?? MODEL)))
  }
  throw new Error(`unexpected upstream URL: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

async function post(): Promise<Response> {
  setDisabledModels([])
  setModels({ object: "list", data: [mockModel(MODEL, { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] })] })
  return app.request(`/v1beta/models/${MODEL}:streamGenerateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
  })
}

describe("Gemini v4 — upstream stream truncation detection", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    truncatedToolCall = false
    setStateForTests({ copilotToken: "test-token", accountType: "individual", vsCodeVersion: "1.100.0", responseHeaderTimeout: 0, streamIdleTimeout: 0 })
    applyFetchMock(upstreamFetchMock)
  })

  test("truncated upstream → Gemini error frame, no UNSPECIFIED terminal, history FAILED", async () => {
    // HIGH-1: a clean-EOF truncation also emits the rich [upstream-diagnostics] line, kind=truncated.
    const diagSpy = spyOn(consola, "error").mockImplementation(Object.assign(() => {}, { raw: () => {} }))
    let sse: string
    try {
      sse = await (await post()).text()
    } finally {
      const diagLine = diagSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("[upstream-diagnostics] STREAM DISCONNECT"))
      diagSpy.mockRestore()
      expect(diagLine).toBeDefined()
      expect(diagLine).toContain("kind=truncated")
      expect(diagLine).not.toContain("frames=0")
      expect(diagLine).toContain("last-frame=chat.completion.chunk@")
    }

    // A clean terminator: a Gemini-shape error frame, and NOT a misleading UNSPECIFIED terminal.
    expect(sse).toContain('"error"')
    expect(sse).toContain("truncated")
    expect(sse).not.toContain("FINISH_REASON_UNSPECIFIED")

    const entry = getHistory({ endpoint: "gemini-generate-content", limit: 5 }).entries[0]
    expect(entry).toBeDefined()
    expect(entry.state).toBe("failed")
    expect(entry.attempts?.at(-1)?.upstreamResponse?.success).toBe(false)
    expect(String(entry._index?.derived?.failureReason)).toContain("truncated")
    // The synthesized Gemini error frame the client received is recorded in the forwarded
    // (proxy→client) track — asserts the writeSynthetic→recordForwarded→fail ordering on the Gemini path.
    expect((entry.clientResponse?.sseEvents ?? []).some((e) => e.raw.includes('"error"'))).toBe(true)
  })

  test("truncation with a complete buffered tool-call → the functionCall is still forwarded (no content drop)", async () => {
    truncatedToolCall = true
    const sse = await (await post()).text()

    // The complete tool-call buffered before the cutoff must reach the client (Gemini buffers
    // tool-calls to flush; the fix forwards it instead of dropping it on truncation).
    expect(sse).toContain("functionCall")
    expect(sse).toContain("get_weather")
    expect(sse).toContain("SF")
    // Still terminated by the error frame, and still NO misleading UNSPECIFIED terminal.
    expect(sse).toContain('"error"')
    expect(sse).toContain("truncated")
    expect(sse).not.toContain("FINISH_REASON_UNSPECIFIED")

    const entry = getHistory({ endpoint: "gemini-generate-content", limit: 5 }).entries[0]
    expect(entry?.state).toBe("failed")
  })
})
