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
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import {
  //
  applyFetchMock,
  autoRestoreFetch,
} from "../helpers/mock-fetch"
import { autoTestRuntime } from "../helpers/test-bootstrap"

// End-to-end probe for the tool-name sanitization round-trip on the Anthropic
// path: with `sanitize_tool_names` ON, a tool named "search.web" (a dot, which
// the claude class disallows) must reach the upstream as "search_web", and a
// tool_use the upstream emits under "search_web" must be restored to the
// client's original "search.web". The real handler + real client run against a
// mocked global fetch.

interface CapturedTool {
  name: string
}

let capturedTools: Array<CapturedTool> | undefined

/** Non-streaming upstream body containing a tool_use under the SANITIZED name. */
function buildToolUseBody(model: string): string {
  return JSON.stringify({
    id: "msg-toolname-test",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "search_web",
        input: { q: "hello" },
      },
    ],
    model,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 3 },
  })
}

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string; tools?: Array<CapturedTool> }) : {}

  if (url.endsWith("/v1/messages")) {
    capturedTools = payload.tools
    return new Response(buildToolUseBody(payload.model ?? "unknown"), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")

const app = createFullTestApp()

interface ToolUseHttpBody {
  content: Array<{ type: string; name?: string }>
}

describe("POST /v1/messages — tool-name sanitization round-trip", () => {
  autoTestRuntime()
  autoRestoreFetch()

  beforeEach(() => {
    capturedTools = undefined
    upstreamFetchMock.mockClear()
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      fetchTimeout: 0,
      sanitizeToolNames: true,
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

  test("sends sanitized tool name upstream and restores the original in the response", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        messages: [{ role: "user", content: "search the web" }],
        max_tokens: 64,
        stream: false,
        tools: [
          {
            name: "search.web",
            description: "search",
            input_schema: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
      }),
    })

    const body = (await res.json()) as ToolUseHttpBody

    expect(res.status).toBe(200)
    // Request side: upstream received the sanitized (dot-free) name.
    const upstreamNames = (capturedTools ?? []).map((t) => t.name)
    expect(upstreamNames).toContain("search_web")
    expect(upstreamNames).not.toContain("search.web")
    // Response side: tool_use name restored to the client-original name.
    const toolUse = body.content.find((b) => b.type === "tool_use")
    expect(toolUse?.name).toBe("search.web")
  })

  test("with sanitize disabled, the dotted name passes through unchanged", async () => {
    setStateForTests({ sanitizeToolNames: false })

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        messages: [{ role: "user", content: "search the web" }],
        max_tokens: 64,
        stream: false,
        tools: [
          {
            name: "search.web",
            description: "search",
            input_schema: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    // Off path: original dotted name reaches upstream untouched.
    const upstreamNames = (capturedTools ?? []).map((t) => t.name)
    expect(upstreamNames).toContain("search.web")
  })
})
