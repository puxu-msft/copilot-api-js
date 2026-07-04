/**
 * Non-streaming semantic-truncation detection on /chat/completions.
 *
 * Covers the audit MEDIUM-1 fix: an upstream 200 with an EMPTY `choices` array
 * (a structural truncation) must NOT throw a TypeError (500) — it flows through
 * the gate as a missing finish_reason → FAILED, while still forwarding the body.
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
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../helpers/mock-fetch"

const MODEL = "gpt-5.2"

let mode: "empty-choices" | "no-finish" | "ok" = "empty-choices"

function ccBody(): unknown {
  const base = { id: "cmpl_x", object: "chat.completion", model: MODEL, usage: { prompt_tokens: 10, completion_tokens: 4 } }
  if (mode === "empty-choices") return { ...base, choices: [] }
  if (mode === "no-finish") return { ...base, choices: [{ index: 0, message: { role: "assistant", content: "partial" } }] } // no finish_reason
  return { ...base, choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }
}

const upstreamFetchMock = mock(async (input: string | URL | Request) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  if (url.endsWith("/chat/completions")) {
    return new Response(JSON.stringify(ccBody()), { status: 200, headers: { "content-type": "application/json" } })
  }
  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

async function request(): Promise<Response> {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], stream: false }),
  })
}

describe("POST /chat/completions — non-streaming semantic-truncation detection", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    setStateForTests({ copilotToken: "test-token", accountType: "individual", vsCodeVersion: "1.100.0", responseHeaderTimeout: 0 })
    applyFetchMock(upstreamFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { supported_endpoints: ["/chat/completions"] })] })
  })

  test("empty choices array → no crash; client gets the 200, history FAILED (MEDIUM-1)", async () => {
    mode = "empty-choices"
    const res = await request()
    expect(res.status).toBe(200) // NOT a 500 TypeError
    const entry = getHistory({ endpoint: "openai-chat-completions", limit: 1 }).entries[0]
    expect(entry.state).toBe("failed")
    expect(String(entry.outboundResponse?.error)).toContain("finish_reason")
  })

  test("missing finish_reason → FAILED", async () => {
    mode = "no-finish"
    const res = await request()
    expect(res.status).toBe(200)
    const entry = getHistory({ endpoint: "openai-chat-completions", limit: 1 }).entries[0]
    expect(entry.state).toBe("failed")
  })

  test("complete (finish_reason present) → success", async () => {
    mode = "ok"
    await request()
    const entry = getHistory({ endpoint: "openai-chat-completions", limit: 1 }).entries[0]
    expect(entry.state).toBe("completed")
    expect(entry.outboundResponse?.success).toBe(true)
  })
})
