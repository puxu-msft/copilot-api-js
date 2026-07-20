import {
  //
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  //
  getUnsupportedServerToolTypes,
  resetAnthropicFeatureNegotiationForTesting,
} from "~/lib/anthropic/feature-negotiation"
import { PATHS } from "~/lib/config/paths"
import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../helpers/mock-fetch"

// End-to-end probe for the server-tool-rejection self-healing strategy on the
// Anthropic path: a request carrying a native web_search server tool against a
// model whose upstream rejects it with 400 must, after the reactive retry,
// (1) succeed with 200, (2) re-send WITHOUT the web_search tool, and (3) fixate
// `web_search_` in the negotiation cache for the (endpoint, model).

interface CapturedTool {
  name: string
  type?: string
}

const toolTypesPerCall: Array<Array<string>> = []

const WEB_SEARCH_400_BODY = JSON.stringify({
  error: { message: "The use of the web search tool is not supported.", code: "unsupported_value" },
})

function buildOkBody(model: string): string {
  return JSON.stringify({
    id: "msg-srvtool-test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 2 },
  })
}

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string; tools?: Array<CapturedTool> }) : {}

  if (url.endsWith("/v1/messages")) {
    toolTypesPerCall.push((payload.tools ?? []).map((t) => t.type ?? `fn:${t.name}`))
    // First call rejects web_search; subsequent calls (post-strip) succeed.
    if (toolTypesPerCall.length === 1) {
      return new Response(WEB_SEARCH_400_BODY, { status: 400, headers: { "content-type": "application/json" } })
    }
    return new Response(buildOkBody(payload.model ?? "unknown"), { status: 200, headers: { "content-type": "application/json" } })
  }

  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")

const app = createFullTestApp()

let tmpDir = ""
let realPath = ""

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neg-srvtool-http-"))
  realPath = PATHS.NEGOTIATION_STATES
  PATHS.NEGOTIATION_STATES = path.join(tmpDir, "negotiation-states.json")
})

afterAll(async () => {
  PATHS.NEGOTIATION_STATES = realPath
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("POST /v1/messages — server-tool-rejection self-healing", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    toolTypesPerCall.length = 0
    upstreamFetchMock.mockClear()
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
    })
    applyFetchMock(upstreamFetchMock)
    setModels({
      object: "list",
      data: [
        mockModel("claude-sonnet-4.6", {
          vendor: "Anthropic",
          supported_endpoints: ["/v1/messages"],
        }),
      ],
    })
  })

  afterEach(async () => {
    await resetAnthropicFeatureNegotiationForTesting()
  })

  test("400 web-search-not-supported → strips web_search, retries, fixates the cache", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        messages: [{ role: "user", content: "search the web for me" }],
        max_tokens: 64,
        stream: false,
        tools: [
          { name: "web_search", type: "web_search_20250305" },
          { name: "Read", description: "read a file", input_schema: { type: "object" } },
        ],
      }),
    })

    expect(res.status).toBe(200)

    // Two upstream hops: first carried web_search (rejected), second stripped it.
    expect(toolTypesPerCall.length).toBe(2)
    expect(toolTypesPerCall[0]).toContain("web_search_20250305")
    expect(toolTypesPerCall[1]).not.toContain("web_search_20250305")
    // The non-server tool survives the strip.
    expect(toolTypesPerCall[1]).toContain("fn:Read")

    // Cache fixated for the (endpoint, model) so future first hops pre-strip.
    expect(getUnsupportedServerToolTypes("claude-sonnet-4.6")).toEqual(["web_search_"])
  })
})
