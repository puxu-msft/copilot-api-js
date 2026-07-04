/**
 * Integration tests for the web_search double-hop orchestrator.
 *
 * Exercises orchestrateWebSearch directly with a mocked upstream fetch:
 *   - search-failure fallback → web_search_tool_result_error block + ok:false
 *   - no-search branch → first-hop response returned as-is
 *   - searxng-not-running readiness failure → structured failure (no throw)
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

import { orchestrateWebSearch } from "~/lib/anthropic/web-search"
import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"
import * as tokenModule from "~/lib/token"

import { mockModel } from "../../helpers/factories"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../../helpers/mock-fetch"

// ============================================================================
// Mock
// ============================================================================

let messagesHits = 0
let responsesOk = true

function toolUseHopBody(): string {
  return JSON.stringify({
    id: "msg-hop1",
    type: "message",
    role: "assistant",
    model: "claude-opus-4.6",
    content: [{ type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "q" } }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  })
}

/** First hop emitting multiple parallel web_search tool_use blocks (round limit = 1). */
function multiSearchHopBody(): string {
  return JSON.stringify({
    id: "msg-hop1-multi",
    type: "message",
    role: "assistant",
    model: "claude-opus-4.6",
    content: [
      { type: "tool_use", id: "toolu_1", name: "web_search", input: { query: "q1" } },
      { type: "tool_use", id: "toolu_2", name: "web_search", input: { query: "q2" } },
      { type: "tool_use", id: "toolu_3", name: "web_search", input: { query: "q3" } },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  })
}

function directHopBody(): string {
  return JSON.stringify({
    id: "msg-direct",
    type: "message",
    role: "assistant",
    model: "claude-opus-4.6",
    content: [{ type: "text", text: "No search needed." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 4 },
  })
}

function secondHopBody(): string {
  return JSON.stringify({
    id: "msg-hop2",
    type: "message",
    role: "assistant",
    model: "claude-opus-4.6",
    content: [{ type: "text", text: "Answer from search results." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 50, output_tokens: 9 },
  })
}

let firstHopSearches = true
let firstHopMultiSearch = false
let pendingAuth401 = false

const upstreamFetchMock = mock(async (input: string | URL | Request) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url

  if (url.endsWith("/v1/messages")) {
    // Simulate one expired-token 401 to exercise the orchestrator's token refresh.
    if (pendingAuth401) {
      pendingAuth401 = false
      return new Response(JSON.stringify({ error: { message: "auth expired", type: "authentication_error" } }), { status: 401 })
    }
    messagesHits += 1
    if (messagesHits === 1)
      return new Response(
        firstHopSearches ?
          firstHopMultiSearch ? multiSearchHopBody()
          : toolUseHopBody()
        : directHopBody(),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    return new Response(secondHopBody(), { status: 200, headers: { "content-type": "application/json" } })
  }

  if (url.endsWith("/responses")) {
    if (!responsesOk) return new Response(JSON.stringify({ error: { message: "search model unavailable", type: "invalid_request_error" } }), { status: 400 })
    return new Response(
      JSON.stringify({
        id: "r",
        model: "gpt-5.5",
        output: [{ type: "message", content: [{ type: "output_text", text: "1. [A](https://a.com)" }] }],
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )
  }

  throw new Error(`unexpected URL: ${url}`)
})

const basePayload = {
  model: "claude-opus-4.6",
  max_tokens: 256,
  messages: [{ role: "user" as const, content: "search please" }],
  tools: [{ name: "web_search", type: "web_search_20250305" }],
}

describe("orchestrateWebSearch", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    messagesHits = 0
    responsesOk = true
    firstHopSearches = true
    firstHopMultiSearch = false
    pendingAuth401 = false
    upstreamFetchMock.mockClear()
    setStateForTests({ copilotToken: "test-token", accountType: "individual", vsCodeVersion: "1.100.0", responseHeaderTimeout: 0 })
    applyFetchMock(upstreamFetchMock)
    setModels({ object: "list", data: [mockModel("claude-opus-4.6", { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  test("happy path: synthesizes server_tool_use + result + text, merges usage, searched=true", async () => {
    const result = await orchestrateWebSearch({ payload: basePayload, resolvedModel: undefined, backend: "gpt-5.5" })
    expect(result.searched).toBe(true)
    expect(result.search?.ok).toBe(true)

    const content = result.response.content as unknown as Array<Record<string, unknown>>
    expect(content.map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result", "text"])
    // Usage merges hop1(10/5) + hop2(50/9) + search(5/5) = 65 in / 19 out
    const usage = result.response.usage as unknown as { input_tokens: number; output_tokens: number }
    expect(usage.input_tokens).toBe(65)
    expect(usage.output_tokens).toBe(19)
  })

  test("multiple parallel web_search tool_uses: acts on first, reports droppedSearchCount (M3)", async () => {
    firstHopMultiSearch = true
    const result = await orchestrateWebSearch({ payload: basePayload, resolvedModel: undefined, backend: "gpt-5.5" })
    expect(result.searched).toBe(true)
    // 3 requested, round limit 1 → 2 dropped, surfaced (not silently discarded).
    expect(result.droppedSearchCount).toBe(2)
    // Still synthesizes a valid response from the first search.
    const content = result.response.content as unknown as Array<Record<string, unknown>>
    expect(content.map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result", "text"])
  })

  test("single web_search tool_use: droppedSearchCount is undefined (no false positive)", async () => {
    const result = await orchestrateWebSearch({ payload: basePayload, resolvedModel: undefined, backend: "gpt-5.5" })
    expect(result.droppedSearchCount).toBeUndefined()
  })

  test("search failure: structured error block, ok=false, still synthesizes (no throw)", async () => {
    responsesOk = false
    const result = await orchestrateWebSearch({ payload: basePayload, resolvedModel: undefined, backend: "gpt-5.5" })
    expect(result.searched).toBe(true)
    expect(result.search?.ok).toBe(false)

    const content = result.response.content as unknown as Array<Record<string, unknown>>
    expect(content[1].type).toBe("web_search_tool_result")
    expect(content[1].content).toEqual({ type: "web_search_tool_result_error", error_code: "unavailable" })
    // Second hop still ran (search results were empty, model answers from context).
    expect(messagesHits).toBe(2)
  })

  test("no-search branch: returns first-hop response, searched=false, no search/second hop", async () => {
    firstHopSearches = false
    const result = await orchestrateWebSearch({ payload: basePayload, resolvedModel: undefined, backend: "gpt-5.5" })
    expect(result.searched).toBe(false)
    expect(result.search).toBeUndefined()
    expect(messagesHits).toBe(1)
    const content = result.response.content as unknown as Array<Record<string, unknown>>
    expect(content[0]).toMatchObject({ type: "text", text: "No search needed." })
  })

  test("not-configured backend: structured failure, no /responses call", async () => {
    const result = await orchestrateWebSearch({ payload: basePayload, resolvedModel: undefined, backend: "" })
    expect(result.searched).toBe(true)
    expect(result.search?.ok).toBe(false)
    expect(result.search?.text).toContain("not configured")
    // hop1 + hop2 ran; no /responses fetch happened.
    const responsesCalls = upstreamFetchMock.mock.calls.filter((c) => {
      const u =
        typeof c[0] === "string" ? c[0]
        : c[0] instanceof URL ? c[0].href
        : c[0].url
      return u.endsWith("/responses")
    })
    expect(responsesCalls).toHaveLength(0)
  })

  test("first hop refreshes the Copilot token once on 401 and retries (H1)", async () => {
    // Arrange — the upstream returns one 401, then a token refresh yields a new
    // token and the retry succeeds. Without the orchestrator's refresh wrapper
    // this would hard-fail (createAnthropicMessages does no token refresh).
    pendingAuth401 = true
    const refresh = mock(async () => ({ token: "new-token" }))
    const spy = spyOn(tokenModule, "getCopilotTokenManager").mockImplementation(
      () => ({ refresh }) as unknown as ReturnType<typeof tokenModule.getCopilotTokenManager>,
    )

    try {
      // Act
      const result = await orchestrateWebSearch({ payload: basePayload, resolvedModel: undefined, backend: "gpt-5.5" })

      // Assert — refresh happened once and the orchestration still completed.
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(result.searched).toBe(true)
      expect(pendingAuth401).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })
})
