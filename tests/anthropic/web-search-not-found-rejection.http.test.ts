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
  isServerToolHistoryDowngradeLearned,
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

// End-to-end probe for the reactive web_search-not-found self-healing strategy on
// the Anthropic path (RFC gap C): a request carrying prior-turn
// server_tool_use{web_search} history against a model NOT in the proactive
// server-tool-history-downgrade set (so the first hop ships the native block
// unmodified) must, after the reactive retry,
// (1) succeed with 200, (2) re-send WITHOUT any server_tool_use block (the
// re-sanitized baseline downgrades it to a plain tool_use), and (3) fixate the
// model in the learned downgrade set so future first hops pre-downgrade.

interface CapturedBlock {
  type?: string
  name?: string
}
interface CapturedMessage {
  role: string
  content?: string | Array<CapturedBlock>
}

const bodiesPerCall: Array<Array<CapturedMessage>> = []

// Mirrors the RAW upstream wire body: JSON.stringify does NOT escape single
// quotes, so responseText literally contains `Tool 'web_search' not found in
// provided tools` (verified via node probe).
const WEB_SEARCH_NOT_FOUND_400_BODY = JSON.stringify({
  error: {
    type: "invalid_request_error",
    message: "Tool 'web_search' not found in provided tools",
  },
})

function buildOkBody(model: string): string {
  return JSON.stringify({
    id: "msg-websearch-notfound-test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 2 },
  })
}

/** Whether any message carries a native server_tool_use block. */
function hasServerToolUse(messages: Array<CapturedMessage>): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "server_tool_use"))
}

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string; messages?: Array<CapturedMessage> }) : {}

  if (url.endsWith("/v1/messages")) {
    bodiesPerCall.push(payload.messages ?? [])
    // First call rejects (web_search not provisioned); subsequent calls (post re-sanitize) succeed.
    if (bodiesPerCall.length === 1) {
      return new Response(WEB_SEARCH_NOT_FOUND_400_BODY, { status: 400, headers: { "content-type": "application/json" } })
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neg-websearch-notfound-http-"))
  realPath = PATHS.NEGOTIATION_STATES
  PATHS.NEGOTIATION_STATES = path.join(tmpDir, "negotiation-states.json")
})

afterAll(async () => {
  PATHS.NEGOTIATION_STATES = realPath
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("POST /v1/messages — reactive web_search-not-found self-healing", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    bodiesPerCall.length = 0
    upstreamFetchMock.mockClear()
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      // Keep the PROACTIVE (global config) downgrade OFF so the first hop ships
      // the native server_tool_use block — the reactive strategy must learn the
      // per-model downgrade from the 400.
      rewriteHistoryServerTools: false,
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

  test("400 web_search not found → learns the model, re-downgrades the baseline, retries clean", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        messages: [
          { role: "user", content: "search please" },
          {
            role: "assistant",
            content: [
              { type: "server_tool_use", id: "srvtoolu_abc", name: "web_search", input: { query: "anthropic tokenizer" } },
              {
                type: "web_search_tool_result",
                tool_use_id: "srvtoolu_abc",
                content: [
                  { type: "web_search_result", title: "Result One", url: "https://example.com/1", encrypted_content: "abc123nonempty", page_age: null },
                ],
              },
              { type: "text", text: "Here is the answer." },
            ],
          },
          { role: "user", content: "thanks, follow up" },
        ],
        max_tokens: 64,
        stream: false,
      }),
    })

    expect(res.status).toBe(200)

    // Two upstream hops: first carried the native server_tool_use, second downgraded.
    expect(bodiesPerCall.length).toBe(2)
    expect(hasServerToolUse(bodiesPerCall[0])).toBe(true)
    expect(hasServerToolUse(bodiesPerCall[1])).toBe(false)

    // Learned downgrade set fixated so future first hops proactively downgrade.
    expect(isServerToolHistoryDowngradeLearned("claude-sonnet-4.6")).toBe(true)
  })
})
