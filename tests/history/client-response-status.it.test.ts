/**
 * P3 — clientResponse.status capture at the forward boundary.
 *
 * The proxy→client HTTP status (`clientResponse.status`) is a first-class capture
 * landed in P3. It is written at the handler write-out point (co-located with
 * `setInboundResponseHeaders`, BEFORE complete()/fail()/abort() snapshots the
 * entry) and, for defer-settle error paths, by the observability middleware's
 * safety net (`c.res.status` before `completeFromHttpStatus`).
 *
 * Oracle: the ACTUAL `response.status` returned by `app.request` — the status the
 * client genuinely received — asserted equal to `entry.clientResponse.status`.
 * This is an independent oracle (not a hardcoded literal), so a wire regression
 * (wrong status captured) lands unambiguously.
 *
 * Covers: success 200 (non-streaming + streaming, multiple formats) AND a
 * failure-forward non-200 (anthropic thinking-only refusal → client 500, a
 * proxy-introduced error forwarded in-handler). `clientResponse.status` is
 * DECOUPLED from the entry verdict — a failed entry can forward a 200 or a 500.
 *
 * Also covers the PRE-RESPONSE client-abort path: 499 is a KNOWN literal decided
 * in-handler (before the upstream forwards anything) and is captured on the
 * clientResponse leg BEFORE ctx.abort() freezes the entry — so an `aborted` entry
 * carries clientResponse.status === 499.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type {
  //
  EndpointType,
  HistoryEntry,
} from "~/lib/history/types"

import { getHistory } from "~/lib/history"
import {
  //
  setModelOverrides,
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"
import { createFullTestApp } from "../helpers/test-app"

function latest(endpoint: EndpointType): HistoryEntry | undefined {
  return getHistory({ endpoint }).entries[0]
}

// ── upstream mocks ──────────────────────────────────────────────────────────

const ANTHROPIC_STREAM = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg-1", type: "message", role: "assistant", model: "claude-sonnet-4.6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
]

const ANTHROPIC_JSON = JSON.stringify({
  id: "msg-2",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4.6",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 2 },
})

// Thinking-only refusal: no text / tool_use block + stop_reason "refusal" → the
// non-streaming refusal gate forwards a 500 error body to the client (default
// state.refusalSseRewrite === "error").
const ANTHROPIC_REFUSAL_JSON = JSON.stringify({
  id: "msg-r",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4.6",
  content: [{ type: "thinking", thinking: "...", signature: "sig" }],
  stop_reason: "refusal",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 2 },
})

const CC_JSON = JSON.stringify({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "gpt-4o",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop", logprobs: null }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})

let refusalNext = false

const upstreamMock = mock((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { stream?: boolean }) : {}

  if (url.includes("/v1/messages") || url.includes("/messages")) {
    if (payload.stream) return Promise.resolve(createSseResponse(ANTHROPIC_STREAM))
    const body = refusalNext ? ANTHROPIC_REFUSAL_JSON : ANTHROPIC_JSON
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }))
  }
  if (url.includes("/chat/completions")) {
    return Promise.resolve(new Response(CC_JSON, { status: 200, headers: { "content-type": "application/json" } }))
  }
  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const app = createFullTestApp()

const CLIENT_HEADERS = { "Content-Type": "application/json", authorization: "Bearer client-secret-xyz" }

function setModel(name: string, vendor: string, endpoints: Array<string>): void {
  setModels({ object: "list", data: [mockModel(name, { vendor, supported_endpoints: endpoints })] })
  setModelOverrides({})
}

describe("P3 clientResponse.status capture at forward boundary", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamMock.mockClear()
    refusalNext = false
    setStateForTests({ copilotToken: "tok", accountType: "individual", vsCodeVersion: "1.100.0", responseHeaderTimeout: 0 })
    applyFetchMock(upstreamMock)
  })

  test("anthropic non-streaming success → clientResponse.status === 200", async () => {
    setModel("claude-sonnet-4.6", "Anthropic", ["/v1/messages"])
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: CLIENT_HEADERS,
      body: JSON.stringify({ model: "claude-sonnet-4.6", max_tokens: 256, stream: false, messages: [{ role: "user", content: "go" }] }),
    })
    expect(res.status).toBe(200)
    await res.json()
    const entry = latest("anthropic-messages")
    expect(entry?.clientResponse?.status).toBe(res.status)
    expect(entry?.clientResponse?.status).toBe(200)
  })

  test("anthropic streaming success → clientResponse.status === 200", async () => {
    setModel("claude-sonnet-4.6", "Anthropic", ["/v1/messages"])
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: CLIENT_HEADERS,
      body: JSON.stringify({ model: "claude-sonnet-4.6", max_tokens: 256, stream: true, messages: [{ role: "user", content: "go" }] }),
    })
    expect(res.status).toBe(200)
    await res.text()
    const entry = latest("anthropic-messages")
    expect(entry?.clientResponse?.status).toBe(res.status)
    expect(entry?.clientResponse?.status).toBe(200)
  })

  test("openai-cc non-streaming success → clientResponse.status === 200", async () => {
    setModel("gpt-4o", "OpenAI", ["/chat/completions"])
    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: CLIENT_HEADERS,
      body: JSON.stringify({ model: "gpt-4o", stream: false, messages: [{ role: "user", content: "go" }] }),
    })
    expect(res.status).toBe(200)
    await res.json()
    const entry = latest("openai-chat-completions")
    expect(entry?.clientResponse?.status).toBe(res.status)
    expect(entry?.clientResponse?.status).toBe(200)
  })

  test("anthropic thinking-only refusal → client 500, clientResponse.status === 500 (failure-forward)", async () => {
    setModel("claude-sonnet-4.6", "Anthropic", ["/v1/messages"])
    refusalNext = true
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: CLIENT_HEADERS,
      body: JSON.stringify({ model: "claude-sonnet-4.6", max_tokens: 256, stream: false, messages: [{ role: "user", content: "go" }] }),
    })
    expect(res.status).toBe(500)
    await res.text()
    const entry = latest("anthropic-messages")
    // The entry verdict is a failure, yet the forwarded status is captured verbatim —
    // clientResponse.status is decoupled from the entry state (richest-data-flow).
    expect(entry?.state).toBe("failed")
    expect(entry?.clientResponse?.status).toBe(res.status)
    expect(entry?.clientResponse?.status).toBe(500)
  })

  test("pre-response client abort → client 499, clientResponse.status === 499 (aborted, decided in-handler)", async () => {
    setModel("claude-sonnet-4.6", "Anthropic", ["/v1/messages"])
    // Client disconnects while the handler awaits upstream headers: abort the request signal
    // (→ bridgeClientAbort flips the handler's clientAbort), then reject with an http2-style
    // AbortError (upstream never returned headers). The handler's settled-path catch takes the
    // pre-response abort branch → sets clientResponse.status = 499 BEFORE ctx.abort() snapshots,
    // then returns 499. Mirrors tests/anthropic/pre-response-abort.http.test.ts.
    const clientAbort = new AbortController()
    applyFetchMock((() => {
      clientAbort.abort()
      const e = new Error("The operation was aborted.")
      e.name = "AbortError"
      return Promise.reject(e)
    }) as Parameters<typeof applyFetchMock>[0])

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: CLIENT_HEADERS,
      body: JSON.stringify({ model: "claude-sonnet-4.6", max_tokens: 256, stream: true, messages: [{ role: "user", content: "go" }] }),
      signal: clientAbort.signal,
    })
    expect(res.status).toBe(499)
    await res.text().catch(() => undefined)
    const entry = latest("anthropic-messages")
    // The pre-response abort settles as `aborted`, yet the KNOWN forwarded 499 is captured
    // verbatim — clientResponse.status is decoupled from the entry state (richest-data-flow).
    expect(entry?.state).toBe("aborted")
    expect(entry?.clientResponse?.status).toBe(res.status)
    expect(entry?.clientResponse?.status).toBe(499)
  })
})
