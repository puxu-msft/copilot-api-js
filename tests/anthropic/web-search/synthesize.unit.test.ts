/**
 * Unit tests for web_search pure helpers: result parsing, backend selection,
 * tool detection, and response/event synthesis block shapes.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { Tool } from "~/types/api/anthropic"

import {
  //
  accumulateAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "~/lib/anthropic/stream-accumulator"
import {
  //
  formatSearchResultsText,
  parseSearchResults,
  parseWebSearchBackend,
} from "~/lib/anthropic/web-search/backends"
import {
  //
  isWebSearchTool,
  payloadHasWebSearch,
} from "~/lib/anthropic/web-search/detect"
import {
  //
  buildWebSearchResponse,
  webSearchResponseToEvents,
} from "~/lib/anthropic/web-search/synthesize"

// ============================================================================
// parseSearchResults
// ============================================================================

describe("parseSearchResults", () => {
  test("extracts markdown links with titles", () => {
    const text = "1. [Example Title](https://example.com/page)\n2. [Other](https://other.org/x)"
    const results = parseSearchResults(text)
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ title: "Example Title", url: "https://example.com/page" })
    expect(results[1]).toEqual({ title: "Other", url: "https://other.org/x" })
  })

  test("extracts bare URLs and derives title from the line", () => {
    const text = "1. Cool Article - https://example.com/cool"
    const results = parseSearchResults(text)
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe("https://example.com/cool")
    expect(results[0].title).toBe("Cool Article")
  })

  test("dedupes by URL and caps at 8 results", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `- https://example.com/${i % 10}`)
    // 0..9 unique then 10,11 repeat 0,1 → 10 unique URLs, capped at 8
    const results = parseSearchResults(lines.join("\n"))
    expect(results).toHaveLength(8)
    const urls = new Set(results.map((r) => r.url))
    expect(urls.size).toBe(8)
  })

  test("returns empty array for text without URLs", () => {
    expect(parseSearchResults("no links here\njust text")).toEqual([])
  })

  test("falls back to hostname when title is empty", () => {
    const results = parseSearchResults("https://example.com/page")
    expect(results[0].title).toBe("example.com")
  })
})

// ============================================================================
// parseWebSearchBackend
// ============================================================================

describe("parseWebSearchBackend", () => {
  test("empty / whitespace → not-configured", () => {
    expect(parseWebSearchBackend("")).toEqual({ type: "not-configured" })
    expect(parseWebSearchBackend("   ")).toEqual({ type: "not-configured" })
    expect(parseWebSearchBackend(undefined)).toEqual({ type: "not-configured" })
  })

  test("searxng (case-insensitive) → searxng", () => {
    expect(parseWebSearchBackend("searxng")).toEqual({ type: "searxng" })
    expect(parseWebSearchBackend("SearXNG")).toEqual({ type: "searxng" })
  })

  test("any other value → copilot-http model id", () => {
    expect(parseWebSearchBackend("gpt-5.5")).toEqual({ type: "copilot-http", model: "gpt-5.5" })
  })
})

// ============================================================================
// formatSearchResultsText
// ============================================================================

describe("formatSearchResultsText", () => {
  test("empty results → empty string", () => {
    expect(formatSearchResultsText([], "q")).toBe("")
  })

  test("formats numbered lines with optional snippet", () => {
    const text = formatSearchResultsText(
      [
        { title: "A", url: "https://a.com", snippet: "blurb" },
        { title: "B", url: "https://b.com" },
      ],
      "query",
    )
    expect(text).toContain('Web search results for query: "query"')
    expect(text).toContain("1. A - https://a.com")
    expect(text).toContain("blurb")
    expect(text).toContain("2. B - https://b.com")
  })
})

// ============================================================================
// detect
// ============================================================================

describe("isWebSearchTool / payloadHasWebSearch", () => {
  test("matches native web_search server tool (dated type)", () => {
    const tool: Tool = { name: "web_search", type: "web_search_20250305" }
    expect(isWebSearchTool(tool)).toBe(true)
  })

  test("matches Claude Code WebSearch tool by name", () => {
    expect(isWebSearchTool({ name: "WebSearch" } as Tool)).toBe(true)
  })

  test("does not match a plain custom tool named web_search without server type", () => {
    expect(isWebSearchTool({ name: "web_search", input_schema: { type: "object" } } as Tool)).toBe(false)
  })

  test("does not match unrelated tools", () => {
    expect(isWebSearchTool({ name: "Bash" } as Tool)).toBe(false)
  })

  test("payloadHasWebSearch detects presence in tools array", () => {
    expect(payloadHasWebSearch({ model: "m", max_tokens: 1, messages: [], tools: [{ name: "WebSearch" } as Tool] })).toBe(true)
    expect(payloadHasWebSearch({ model: "m", max_tokens: 1, messages: [], tools: [{ name: "Bash" } as Tool] })).toBe(false)
    expect(payloadHasWebSearch({ model: "m", max_tokens: 1, messages: [] })).toBe(false)
  })
})

// ============================================================================
// buildWebSearchResponse
// ============================================================================

describe("buildWebSearchResponse", () => {
  test("builds server_tool_use → web_search_tool_result → text sequence", () => {
    const response = buildWebSearchResponse({
      query: "weather today",
      results: [{ title: "Forecast", url: "https://weather.com" }],
      text: "It will be sunny.",
      model: "claude-opus-4.6",
      usage: { input_tokens: 100, output_tokens: 50 },
    })

    const content = response.content as unknown as Array<Record<string, unknown>>
    expect(content).toHaveLength(3)

    expect(content[0]).toMatchObject({ type: "server_tool_use", name: "web_search", input: { query: "weather today" } })
    const toolUseId = content[0].id as string
    expect(toolUseId).toStartWith("srvtoolu_")

    expect(content[1]).toMatchObject({ type: "web_search_tool_result", tool_use_id: toolUseId })
    const resultContent = content[1].content as Array<Record<string, unknown>>
    expect(resultContent[0]).toMatchObject({ type: "web_search_result", title: "Forecast", url: "https://weather.com" })

    expect(content[2]).toEqual({ type: "text", text: "It will be sunny." })

    const usage = response.usage as unknown as Record<string, unknown>
    expect(usage.input_tokens).toBe(100)
    expect(usage.output_tokens).toBe(50)
    expect(usage.server_tool_use).toEqual({ web_search_requests: 1 })
  })

  test("emits a structured error block when there are no results", () => {
    const response = buildWebSearchResponse({ query: "q", results: [], text: "fallback", model: "m", usage: { input_tokens: 0, output_tokens: 0 } })
    const content = response.content as unknown as Array<Record<string, unknown>>
    expect(content[1].content).toEqual({ type: "web_search_tool_result_error", error_code: "unavailable" })
  })

  test("omits the text block when second hop produced no text", () => {
    const response = buildWebSearchResponse({
      query: "q",
      results: [{ title: "A", url: "https://a.com" }],
      text: "",
      model: "m",
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    const content = response.content as unknown as Array<Record<string, unknown>>
    expect(content).toHaveLength(2)
    expect(content.some((b) => b.type === "text")).toBe(false)
  })
})

// ============================================================================
// webSearchResponseToEvents
// ============================================================================

describe("webSearchResponseToEvents", () => {
  test("emits a valid message_start → blocks → message_delta → message_stop sequence", () => {
    const response = buildWebSearchResponse({
      query: "q",
      results: [{ title: "A", url: "https://a.com" }],
      text: "Answer.",
      model: "m",
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const events = webSearchResponseToEvents(response)
    const types = events.map((e) => e.type)

    expect(types[0]).toBe("message_start")
    expect(types.at(-1)).toBe("message_stop")
    expect(types.at(-2)).toBe("message_delta")

    // 3 content blocks → 3 start, 3 stop
    expect(types.filter((t) => t === "content_block_start")).toHaveLength(3)
    expect(types.filter((t) => t === "content_block_stop")).toHaveLength(3)
  })

  test("synthesized events round-trip through the accumulator into the same content", () => {
    const response = buildWebSearchResponse({
      query: "weather",
      results: [{ title: "Forecast", url: "https://weather.com" }],
      text: "Sunny.",
      model: "claude-opus-4.6",
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const events = webSearchResponseToEvents(response)

    const acc = createAnthropicStreamAccumulator()
    for (const event of events) accumulateAnthropicStreamEvent(event, acc)

    const blocks = acc.contentBlocks
    expect(blocks[0]).toMatchObject({ type: "server_tool_use", name: "web_search" })
    // server_tool_use input accumulates from the input_json_delta
    expect(JSON.parse((blocks[0] as { input: string }).input)).toEqual({ query: "weather" })
    expect((blocks[1] as { type: string }).type).toBe("web_search_tool_result")
    expect(blocks[2]).toMatchObject({ type: "text", text: "Sunny." })
    expect(acc.outputTokens).toBe(5)
    expect(acc.stopReason).toBe("end_turn")
  })

  // Defensive coverage: buildWebSearchResponse never emits a thinking block
  // today (the double-hop synthesis only assembles server_tool_use / result /
  // text), but if a thinking block is ever handed to webSearchResponseToEvents
  // it MUST emit a protocol-correct frame sequence — NOT the malformed
  // "embedded-signature on content_block_start, no signature_delta" shape that
  // corrupts thinking blocks on the client. These tests assert that contract by
  // synthesizing a response that carries a thinking block directly.
  function responseWithThinking(thinking: string, signature: string) {
    return {
      id: "msg-think",
      type: "message",
      role: "assistant",
      model: "claude-opus-4.6",
      content: [
        { type: "thinking", thinking, signature },
        { type: "text", text: "Answer." },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as unknown as Parameters<typeof webSearchResponseToEvents>[0]
  }

  test("thinking block: start carries NO signature; signature arrives via a synthesized signature_delta", () => {
    const events = webSearchResponseToEvents(responseWithThinking("reasoning…", "SIG-abc-123"))

    const thinkingStart = events.find(
      (e) => e.type === "content_block_start" && (e as { content_block?: { type?: string } }).content_block?.type === "thinking",
    ) as { content_block: Record<string, unknown> } | undefined
    expect(thinkingStart).toBeDefined()
    // Must NOT embed the signature on the start (standard clients ignore it there).
    expect(thinkingStart!.content_block.signature).toBeUndefined()
    expect(thinkingStart!.content_block.thinking).toBe("")

    const deltas = events.filter((e) => e.type === "content_block_delta") as unknown as Array<{ index: number; delta: Record<string, unknown> }>
    const thinkingDelta = deltas.find((d) => (d.delta as { type?: string }).type === "thinking_delta")
    const sigDelta = deltas.find((d) => (d.delta as { type?: string }).type === "signature_delta")
    expect(thinkingDelta?.delta.thinking).toBe("reasoning…")
    expect(sigDelta?.delta.signature).toBe("SIG-abc-123")
    expect(sigDelta?.index).toBe(0)
  })

  test("thinking block: round-trips through the accumulator with its signature intact", () => {
    const events = webSearchResponseToEvents(responseWithThinking("deep thought", "SIG-xyz-789"))
    const acc = createAnthropicStreamAccumulator()
    for (const event of events) accumulateAnthropicStreamEvent(event, acc)

    expect(acc.contentBlocks[0]).toMatchObject({ type: "thinking", thinking: "deep thought", signature: "SIG-xyz-789" })
    expect(acc.contentBlocks[1]).toMatchObject({ type: "text", text: "Answer." })
  })

  test("thinking block with empty text but a signature emits only a signature_delta", () => {
    const events = webSearchResponseToEvents(responseWithThinking("", "SIG-only"))
    const deltas = events.filter((e) => e.type === "content_block_delta") as unknown as Array<{ delta: Record<string, unknown> }>
    expect(deltas.some((d) => (d.delta as { type?: string }).type === "thinking_delta")).toBe(false)
    expect(deltas.some((d) => (d.delta as { type?: string }).type === "signature_delta")).toBe(true)
    // Round-trip keeps the signature.
    const acc = createAnthropicStreamAccumulator()
    for (const event of events) accumulateAnthropicStreamEvent(event, acc)
    expect(acc.contentBlocks[0]).toMatchObject({ type: "thinking", signature: "SIG-only" })
  })
})
