/**
 * Upstream stream truncation detection — Chat Completions path.
 *
 * A complete OpenAI stream always terminates with a `finish_reason` chunk. When the
 * upstream sends content then cleanly closes WITHOUT one, the proxy must settle the
 * entry as FAILED and emit an OpenAI error frame instead of the normal `[DONE]`.
 *
 * See docs/rfc/upstream-stream-truncation-detection.md.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getHistory } from "~/lib/history/store"
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

const MODEL = "gpt-4o"

// Truncated: a content delta, then EOF. NO finish_reason chunk, NO [DONE].
function ccTruncatedFrames(model: string): Array<string> {
  return [
    `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null, logprobs: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null, logprobs: null }] })}\n\n`,
    // EOF — no finish_reason chunk.
  ]
}

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string; stream?: boolean }) : {}
  if (url.endsWith("/chat/completions")) return Promise.resolve(createSseResponse(ccTruncatedFrames(payload.model ?? MODEL)))
  throw new Error(`unexpected upstream URL: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

async function post(): Promise<Response> {
  setDisabledModels([])
  setModels({ object: "list", data: [mockModel(MODEL, { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] })] })
  return app.request("/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], stream: true }),
  })
}

describe("CC v4 — upstream stream truncation detection", () => {
  autoTestRuntime()
  autoRestoreFetch()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    setStateForTests({ copilotToken: "test-token", accountType: "individual", vsCodeVersion: "1.100.0", fetchTimeout: 0, streamIdleTimeout: 0 })
    applyFetchMock(upstreamFetchMock)
  })

  test("truncated CC stream → error frame to client, no [DONE], history FAILED", async () => {
    const sse = await (await post()).text()

    // The partial content the upstream did send is still forwarded.
    expect(sse).toContain("Hel")
    // A clean terminator: an OpenAI error frame, and NOT the normal [DONE].
    expect(sse).toContain('"error"')
    expect(sse).toContain("truncated")
    expect(sse).not.toContain("[DONE]")

    const entry = getHistory({ endpoint: "openai-chat-completions", limit: 5 }).entries[0]
    expect(entry).toBeDefined()
    expect(entry.state).toBe("failed")
    expect(entry.outboundResponse?.success).toBe(false)
    expect(String(entry.outboundResponse?.error)).toContain("truncated")
  })
})
