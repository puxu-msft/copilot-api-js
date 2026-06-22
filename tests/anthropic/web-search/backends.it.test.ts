/**
 * Integration tests for the web_search backends (executeWebSearch).
 *
 * Covers SearXNG JSON parsing + readiness failure and the Copilot Responses
 * search-model output parsing, via a mocked global fetch. Failures are asserted
 * to return structured results (never throw).
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { executeWebSearch } from "~/lib/anthropic/web-search/backends"
import {
  //
  setStateForTests,
} from "~/lib/state"

import { useIsolatedRuntime } from "../../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../../helpers/mock-fetch"

const baseInput = { query: "typescript release", searchInput: "search instruction", maxOutputTokens: 256 }

describe("executeWebSearch — backends", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setStateForTests({ copilotToken: "test-token", accountType: "individual", vsCodeVersion: "1.100.0", fetchTimeout: 0 })
  })

  test("searxng: parses results from JSON and formats text", async () => {
    const fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input
        : input instanceof URL ? input.href
        : input.url
      if (url === "http://localhost:8080" || url === "http://localhost:8080/") return new Response("ok", { status: 200 })
      if (url.startsWith("http://localhost:8080/search")) {
        return new Response(
          JSON.stringify({
            results: [
              { title: "TS 5.9", url: "https://ts.dev/5.9", content: "release notes" },
              { title: "Bad", url: "" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      throw new Error(`unexpected: ${url}`)
    })
    applyFetchMock(fetchMock)

    const result = await executeWebSearch(baseInput, "searxng")
    expect(result.ok).toBe(true)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toEqual({ title: "TS 5.9", url: "https://ts.dev/5.9", snippet: "release notes" })
    expect(result.text).toContain("TS 5.9 - https://ts.dev/5.9")
  })

  test("searxng: readiness probe failure → structured failure (no throw)", async () => {
    const fetchMock = mock(async () => {
      throw new Error("ECONNREFUSED")
    })
    applyFetchMock(fetchMock)

    const result = await executeWebSearch(baseInput, "searxng")
    expect(result.ok).toBe(false)
    expect(result.results).toHaveLength(0)
    expect(result.text).toContain("SearXNG")
  })

  test("copilot-http: parses web_search_call query + message output_text", async () => {
    const fetchMock = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input
        : input instanceof URL ? input.href
        : input.url
      if (url.endsWith("/responses")) {
        return new Response(
          JSON.stringify({
            id: "resp-1",
            model: "gpt-5.5",
            output: [
              { type: "web_search_call", action: { query: "refined query" } },
              { type: "message", content: [{ type: "output_text", text: "1. [Result](https://r.com/x)" }] },
            ],
            usage: { input_tokens: 30, output_tokens: 12 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      throw new Error(`unexpected: ${url}`)
    })
    applyFetchMock(fetchMock)

    const result = await executeWebSearch(baseInput, "gpt-5.5")
    expect(result.ok).toBe(true)
    expect(result.query).toBe("refined query")
    expect(result.results[0]).toEqual({ title: "Result", url: "https://r.com/x" })
    expect(result.inputTokens).toBe(30)
    expect(result.outputTokens).toBe(12)
    expect(result.model).toBe("gpt-5.5")
  })

  test("copilot-http: upstream 400 → structured failure (no throw)", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ error: { message: "nope", type: "x" } }), { status: 400 }))
    applyFetchMock(fetchMock)

    const result = await executeWebSearch(baseInput, "gpt-5.5")
    expect(result.ok).toBe(false)
    expect(result.results).toHaveLength(0)
  })

  test("not-configured backend → structured failure", async () => {
    const result = await executeWebSearch(baseInput, "")
    expect(result.ok).toBe(false)
    expect(result.text).toContain("not configured")
  })
})
