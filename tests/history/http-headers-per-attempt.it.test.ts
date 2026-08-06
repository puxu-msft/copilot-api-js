import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getHistory } from "~/lib/history"
import { setModels } from "~/lib/models/cache"
import {
  //
  setModelMappings,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createFullTestApp } from "../helpers/test-app"

// ============================================================================
// RFC history-http-header-capture Phase 3 — ②③ per-attempt 头持久化
//
// ② legFromWire 此前丢弃 wire headers + history sink onTerminal 的 outboundRequest
//   显式字段投影漏 headers → attempts[].wireRequest.headers / 顶层 outboundRequest
//   腿落盘为空。修复后逐 attempt 完整。
// ③ driver 为每个 attempt 写 setAttemptResponseHeaders(成功 upstream.headers /
//   失败 apiError.responseHeaders)→ attempts[].responseHeaders 逐 attempt 完整。
// ============================================================================

const CC_OK = JSON.stringify({
  id: "c1",
  object: "chat.completion",
  created: 1,
  model: "gpt-4o",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop", logprobs: null }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})

const upstreamMock = mock(
  (): Promise<Response> => Promise.resolve(new Response(CC_OK, { status: 200, headers: { "content-type": "application/json", "x-upstream-marker": "v" } })),
)

const app = createFullTestApp()

describe("Phase 3: per-attempt ②③ 头持久化", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamMock.mockClear()
    setStateForTests({ copilotToken: "tok", accountType: "individual", vsCodeVersion: "1.100.0", responseHeaderTimeout: 0 })
    applyFetchMock(upstreamMock)
    setModels({ object: "list", data: [mockModel("gpt-4o", { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] })] })
    setModelMappings({})
  })

  test("attempts[] 逐 attempt 带 ② wireRequest.headers + ③ responseHeaders;顶层 outboundRequest 腿带原始 headers", async () => {
    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: "Bearer client-x" },
      body: JSON.stringify({ model: "gpt-4o", stream: false, messages: [{ role: "user", content: "go" }] }),
    })
    await res.json()

    const entry = getHistory({ endpoint: "openai-chat-completions" }).entries[0]

    const finalAttempt = entry.attempts?.at(-1)
    // ② final attempt's upstreamRequest leg carries the original headers (previously dropped by the explicit projection)
    expect(finalAttempt?.upstreamRequest?.headers).toBeDefined()
    expect(finalAttempt?.upstreamRequest?.headers?.authorization).toBeDefined()
    expect(finalAttempt?.upstreamRequest?.headers?.authorization).not.toBe("***")

    expect(entry.attempts?.length ?? 0).toBeGreaterThanOrEqual(1)
    for (const a of entry.attempts ?? []) {
      // ② per-attempt 出站请求头
      expect(a.upstreamRequest?.headers?.authorization).toBeDefined()
      // ③ per-attempt 上游响应头
      expect(a.responseHeaders).toBeDefined()
      expect(a.responseHeaders?.["x-upstream-marker"]).toBe("v")
    }
  })
})
