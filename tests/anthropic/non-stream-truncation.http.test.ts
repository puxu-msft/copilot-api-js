/**
 * Non-streaming semantic-truncation detection on /v1/messages.
 *
 * An upstream `200 OK` with a structurally-valid JSON body but NO `stop_reason`
 * is a SEMANTICALLY truncated response. The proxy must NOT silently record it as
 * success ([ OK ]) — it settles the entry as FAILED (honest classification),
 * preserves the partial content (richest-data-flow), while still forwarding the
 * upstream 200 body to the client.
 *
 * See docs/rfc/upstream-stream-truncation-detection.md §3.3 / Phase 3.
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
import { setModels } from "~/lib/models/cache"
import { setStateForTests } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../helpers/mock-fetch"

const MODEL = "claude-opus-4.8"

function anthropicBody(opts: { stopReason: string | null }): unknown {
  return {
    id: "msg_x",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [{ type: "text", text: "partial answer" }],
    ...(opts.stopReason !== null && { stop_reason: opts.stopReason }),
    usage: { input_tokens: 10, output_tokens: 4 },
  }
}

let stopReason: string | null = null

const upstreamFetchMock = mock(async (input: string | URL | Request) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  if (url.endsWith("/v1/messages")) {
    return new Response(JSON.stringify(anthropicBody({ stopReason })), { status: 200, headers: { "content-type": "application/json" } })
  }
  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

async function nonStreamRequest(sessionId: string): Promise<Response> {
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 256, stream: false }),
  })
}

describe("POST /v1/messages — non-streaming semantic-truncation detection", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    stopReason = null
    setStateForTests({ copilotToken: "test-token", accountType: "individual", vsCodeVersion: "1.100.0", responseHeaderTimeout: 0 })
    applyFetchMock(upstreamFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  test("200 without stop_reason → client still gets the body, history records FAILED with the partial", async () => {
    stopReason = null
    const sessionId = "nonstream-trunc-failed"
    const res = await nonStreamRequest(sessionId)

    // The client still receives the upstream 200 body (we don't fabricate an error response).
    expect(res.status).toBe(200)
    const body = (await res.json()) as { content?: unknown }
    expect(body.content).toBeDefined()

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry).toBeDefined()
    // NOT a silent success.
    expect(entry.state).toBe("failed")
    expect(entry.attempts?.at(-1)?.upstreamResponse?.success).toBe(false)
    expect(String(entry._index?.derived?.failureReason)).toContain("stop_reason")
    // richest-data-flow: the partial body is preserved on the failed entry.
    expect(entry.attempts?.at(-1)?.upstreamResponse?.body).not.toBeNull()
  })

  test("200 with stop_reason (regression) → success", async () => {
    stopReason = "end_turn"
    const sessionId = "nonstream-complete"
    const res = await nonStreamRequest(sessionId)
    expect(res.status).toBe(200)

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry).toBeDefined()
    expect(entry.state).toBe("completed")
    expect(entry.attempts?.at(-1)?.upstreamResponse?.success).toBe(true)
  })
})
