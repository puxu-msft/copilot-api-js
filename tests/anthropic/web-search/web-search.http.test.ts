/**
 * HTTP-level round-trip for the web_search double-hop on /v1/messages.
 *
 * Drives the real handler with a mocked upstream fetch:
 *   - first /v1/messages hop → returns a `web_search` tool_use (model decides to search)
 *   - /responses search backend → returns markdown search result text
 *   - second /v1/messages hop → returns the final answer text
 * Then asserts the synthesized client response carries the visible
 * server_tool_use + web_search_tool_result + text sequence (bypassing the
 * server-tool-filter), and that the closed state short-circuits the feature.
 */

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
  setModels,
  setStateForTests,
  setWebSearchConfig,
} from "~/lib/state"

import { mockModel } from "../../helpers/factories"
import {
  //
  applyFetchMock,
  autoRestoreFetch,
} from "../../helpers/mock-fetch"
import { autoTestRuntime } from "../../helpers/test-bootstrap"

// ============================================================================
// Upstream mock — routes by URL suffix, scripts the two hops + search
// ============================================================================

let messagesHits = 0
let responsesHits = 0
let firstHopToolUse = true
let firstHopMultiSearch = false
let firstHopStatus = 200

function firstHopBody(model: string): string {
  // First hop: the model calls the plain `web_search(query)` function tool.
  if (firstHopMultiSearch) {
    return JSON.stringify({
      id: "msg-hop1-multi",
      type: "message",
      role: "assistant",
      model,
      content: [
        { type: "tool_use", id: "toolu_a", name: "web_search", input: { query: "q1" } },
        { type: "tool_use", id: "toolu_b", name: "web_search", input: { query: "q2" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 8 },
    })
  }
  if (firstHopToolUse) {
    return JSON.stringify({
      id: "msg-hop1",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "tool_use", id: "toolu_hop1", name: "web_search", input: { query: "latest TS release" } }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 8 },
    })
  }
  // No-search branch: model answers directly.
  return JSON.stringify({
    id: "msg-direct",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "Direct answer, no search." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 6 },
  })
}

function secondHopBody(model: string): string {
  return JSON.stringify({
    id: "msg-hop2",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "TypeScript 5.9 is the latest release." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 12 },
  })
}

function responsesSearchBody(): string {
  return JSON.stringify({
    id: "resp-search",
    model: "gpt-5.5",
    output: [
      { type: "web_search_call", action: { query: "latest TypeScript release" } },
      { type: "message", content: [{ type: "output_text", text: "1. [TS 5.9 Release](https://devblogs.microsoft.com/typescript/ts-59)" }] },
    ],
    usage: { input_tokens: 200, output_tokens: 40 },
  })
}

const upstreamFetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
  const model = payload.model ?? "unknown"

  if (url.endsWith("/v1/messages")) {
    messagesHits += 1
    // hop 1 then hop 2 (search branch always does two messages calls)
    if (messagesHits === 1 && firstHopStatus !== 200) {
      return new Response(JSON.stringify({ error: { message: "upstream boom", type: "api_error" } }), {
        status: firstHopStatus,
        headers: { "content-type": "application/json" },
      })
    }
    const body = messagesHits === 1 ? firstHopBody(model) : secondHopBody(model)
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
  }

  if (url.endsWith("/responses")) {
    responsesHits += 1
    return new Response(responsesSearchBody(), { status: 200, headers: { "content-type": "application/json" } })
  }

  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../../helpers/test-app")
const app = createFullTestApp()

interface SynthesizedBody {
  id: string
  type: string
  model: string
  content: Array<Record<string, unknown>>
  usage: Record<string, unknown>
}

const webSearchTool = { name: "web_search", type: "web_search_20250305", max_uses: 5 }

describe("POST /v1/messages — web_search double-hop", () => {
  autoTestRuntime()
  autoRestoreFetch()

  beforeEach(() => {
    messagesHits = 0
    responsesHits = 0
    firstHopToolUse = true
    firstHopMultiSearch = false
    firstHopStatus = 200
    upstreamFetchMock.mockClear()
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      fetchTimeout: 0,
    })
    applyFetchMock(upstreamFetchMock)
    setModels({
      object: "list",
      data: [mockModel("claude-opus-4.6", { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })],
    })
    setWebSearchConfig({ webSearchEnabled: true, webSearchBackend: "gpt-5.5" })
  })

  test("synthesizes a response with visible server_tool_use + web_search_tool_result + text", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "What is the latest TypeScript release?" }],
        max_tokens: 256,
        tools: [webSearchTool],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as SynthesizedBody

    // Two model hops + one search sub-request.
    expect(messagesHits).toBe(2)
    expect(responsesHits).toBe(1)

    // Block sequence is visible to the client (NOT filtered by server-tool-filter).
    const types = body.content.map((b) => b.type)
    expect(types).toEqual(["server_tool_use", "web_search_tool_result", "text"])

    expect(body.content[0]).toMatchObject({ type: "server_tool_use", name: "web_search" })
    const toolResult = body.content[1]
    expect(toolResult.type).toBe("web_search_tool_result")
    const resultItems = toolResult.content as Array<Record<string, unknown>>
    expect(resultItems[0]).toMatchObject({ type: "web_search_result", url: "https://devblogs.microsoft.com/typescript/ts-59" })
    expect(body.content[2]).toEqual({ type: "text", text: "TypeScript 5.9 is the latest release." })

    // Merged usage across hops + search.
    expect(body.usage.server_tool_use).toEqual({ web_search_requests: 1 })
  })

  test("streaming path emits the synthesized SSE sequence", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "latest TS?" }],
        max_tokens: 256,
        tools: [webSearchTool],
        stream: true,
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    // A `ping` is emitted first (flushes headers + resets the client idle clock
    // before the two hops + search run) — M1: it must precede message_start.
    expect(text).toContain("event: ping")
    expect(text.indexOf("event: ping")).toBeLessThan(text.indexOf("event: message_start"))
    expect(text).toContain("event: message_start")
    expect(text).toContain('"type":"server_tool_use"')
    expect(text).toContain('"type":"web_search_tool_result"')
    expect(text).toContain("event: message_stop")
    expect(messagesHits).toBe(2)
    expect(responsesHits).toBe(1)
  })

  test("first hop without a search returns the direct response (no synthesis, no search)", async () => {
    firstHopToolUse = false
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 256,
        tools: [webSearchTool],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as SynthesizedBody
    expect(body.content).toEqual([{ type: "text", text: "Direct answer, no search." }])
    expect(messagesHits).toBe(1) // only the first hop
    expect(responsesHits).toBe(0) // no search ran
  })

  test("closed state (webSearchEnabled=false) short-circuits — request goes through the normal path", async () => {
    setWebSearchConfig({ webSearchEnabled: false, webSearchBackend: "gpt-5.5" })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "latest TS?" }],
        max_tokens: 256,
        tools: [webSearchTool],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    // Normal path makes exactly one upstream call and no search; the orchestrator never runs.
    expect(messagesHits).toBe(1)
    expect(responsesHits).toBe(0)
    const body = (await res.json()) as SynthesizedBody
    // First-hop body is returned verbatim (the normal path forwards upstream as-is,
    // server-tool-filter strips nothing here since there are no server blocks).
    expect(body.content[0]).toMatchObject({ type: "tool_use", name: "web_search" })
  })

  test("hard first-hop failure: non-streaming surfaces an error status (reqCtx.fail + rethrow path)", async () => {
    firstHopStatus = 500
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "latest TS?" }],
        max_tokens: 256,
        tools: [webSearchTool],
        stream: false,
      }),
    })

    // The double-hop's first model call failed → the handler's catch marks the
    // request failed and rethrows; the route surfaces a non-2xx to the client.
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(messagesHits).toBe(1) // failed on hop 1, no second hop or search
    expect(responsesHits).toBe(0)
  })

  test("hard first-hop failure: streaming emits a terminal error SSE event (headers already sent)", async () => {
    firstHopStatus = 500
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "latest TS?" }],
        max_tokens: 256,
        tools: [webSearchTool],
        stream: true,
      }),
    })

    // Streaming: 200 + SSE headers were already flushed (via the leading ping),
    // so the failure is surfaced as a terminal `error` event, not an HTTP status.
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("event: ping")
    expect(text).toContain("event: error")
    expect(text).toContain('"type":"error"')
  })

  test("multiple parallel searches: still synthesizes a valid response (M3 dropped-search path)", async () => {
    firstHopMultiSearch = true
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "latest TS?" }],
        max_tokens: 256,
        tools: [webSearchTool],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as SynthesizedBody
    // Acts on the first search only (round limit 1); the extra is dropped+warned
    // but the response is still a complete, valid synthesized sequence.
    expect(body.content.map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result", "text"])
    expect(messagesHits).toBe(2) // first hop (multi) + second hop
    expect(responsesHits).toBe(1) // exactly one search executed
  })
})
