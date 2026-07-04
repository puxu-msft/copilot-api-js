import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type {
  //
  EndpointType,
  HistoryEntry,
} from "~/lib/history/types"

import { getHistory } from "~/lib/history"
import {
  //
  setModelOverrides,
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"
import { createFullTestApp } from "../helpers/test-app"

// ============================================================================
// Phase 0 golden 预捕获 — 锁 RFC history-http-header-capture 改动前的 httpHeaders 行为
//
// 目的（RFC §5 Phase 0）：在旧代码上锁定当前 httpHeaders 的三腿结构 + 敏感头脱敏
// （`***`）+ 第四腿 inboundResponse 缺失。后续 phase 以此守回归：
//   - Phase 1 把敏感头从 `***` 改真实值（届时更新本 golden 的 redaction 断言）。
//   - Phase 2 删 handler-bag 后三腿（含 HTTP-错误失败的 outboundResponse）不得回退。
//   - Phase 4 建第四腿后 hasInboundResponse 由 false 变 true。
// 覆盖 4 格式 ×（完成 + HTTP-错误失败）。per-attempt 重试 golden 待 Phase 3（旧码无 per-attempt 槽）。
// ============================================================================

/** 稳定的 httpHeaders 形状摘要：腿集 + 第四腿缺失 + 敏感头脱敏现状 + 上游响应头未脱敏。 */
function summarizeHttpHeaders(entry: HistoryEntry | undefined) {
  const h = entry?.httpHeaders
  return {
    legs: h ? Object.keys(h).sort() : [],
    hasInboundResponse: Boolean(h?.inboundResponse),
    inboundAuth: h?.inboundRequest?.authorization,
    outboundAuth: h?.outboundRequest?.authorization,
    outboundRespUpstream: h?.outboundResponse?.["x-test-upstream"],
    inboundRespContentType: h?.inboundResponse?.["content-type"],
  }
}

function latest(endpoint: EndpointType): HistoryEntry | undefined {
  return getHistory({ endpoint }).entries[0]
}

// ── upstream mock（按 URL 分流 + scenario 控制成败）──────────────────────────

let failNext = false

function withMarker(res: Response, marker: string): Response {
  res.headers.set("x-test-upstream", marker)
  return res
}

function fail502(): Response {
  return new Response(JSON.stringify({ type: "error", error: { message: "upstream boom" } }), {
    status: 502,
    headers: { "content-type": "application/json", "x-test-upstream": "fail-v", "retry-after": "3" },
  })
}

const CC_JSON = (model: string): string =>
  JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop", logprobs: null }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })

const RESPONSES_JSON = (model: string): string =>
  JSON.stringify({
    id: "resp-1",
    object: "response",
    created_at: 1,
    status: "completed",
    model,
    output: [{ type: "message", id: "msg-1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi" }] }],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  })

const ANTHROPIC_STREAM = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg-1", type: "message", role: "assistant", model: "claude-sonnet-4.6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
]

const ANTHROPIC_JSON = JSON.stringify({
  id: "msg-2",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4.6",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 2 },
})

const upstreamMock = mock((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  if (failNext) return Promise.resolve(fail502())

  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string; stream?: boolean }) : {}
  const model = payload.model ?? "unknown"

  if (url.includes("/v1/messages") || url.includes("/messages")) {
    if (payload.stream) return Promise.resolve(withMarker(createSseResponse(ANTHROPIC_STREAM), "stream-v"))
    return Promise.resolve(new Response(ANTHROPIC_JSON, { status: 200, headers: { "content-type": "application/json", "x-test-upstream": "json-v" } }))
  }
  if (url.includes("/responses")) {
    return Promise.resolve(new Response(RESPONSES_JSON(model), { status: 200, headers: { "content-type": "application/json", "x-test-upstream": "resp-v" } }))
  }
  if (url.includes("/chat/completions")) {
    return Promise.resolve(new Response(CC_JSON(model), { status: 200, headers: { "content-type": "application/json", "x-test-upstream": "cc-v" } }))
  }
  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const app = createFullTestApp()

const CLIENT_HEADERS = { "Content-Type": "application/json", authorization: "Bearer client-secret-xyz", "x-client-marker": "phase0" }

function setModel(name: string, vendor: string, endpoints: Array<string>): void {
  setModels({ object: "list", data: [mockModel(name, { vendor, supported_endpoints: endpoints })] })
  setModelOverrides({})
}

// ── 通用断言：四腿齐(Phase 4 建 inboundResponse) / 请求头存原始(Phase 1) / 上游响应头真实 ──

function expectCurrentShape(endpoint: EndpointType, upstreamMarker: string): void {
  const s = summarizeHttpHeaders(latest(endpoint))
  // RFC Phase 4: 第四腿 inboundResponse(Proxy→Client)已建
  expect(s.legs).toEqual(["inboundRequest", "inboundResponse", "outboundRequest", "outboundResponse"])
  expect(s.hasInboundResponse).toBe(true)
  expect(s.inboundRespContentType).toBeDefined()
  // RFC Phase 1: 敏感头存原始未脱敏(非 "***")
  expect(s.inboundAuth).toBe("Bearer client-secret-xyz")
  expect(s.outboundAuth).toBeDefined()
  expect(s.outboundAuth).not.toBe("***")
  expect(s.outboundRespUpstream).toBe(upstreamMarker)
}

describe("Phase 0 golden: httpHeaders 捕获现状（4 格式 × 完成/失败）", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamMock.mockClear()
    failNext = false
    setStateForTests({ copilotToken: "tok", accountType: "individual", vsCodeVersion: "1.100.0", responseHeaderTimeout: 0 })
    applyFetchMock(upstreamMock)
  })

  // ── Anthropic ──
  test("anthropic 流式完成", async () => {
    setModel("claude-sonnet-4.6", "Anthropic", ["/v1/messages"])
    await (
      await app.request("/v1/messages", {
        method: "POST",
        headers: CLIENT_HEADERS,
        body: JSON.stringify({ model: "claude-sonnet-4.6", max_tokens: 256, stream: true, messages: [{ role: "user", content: "go" }] }),
      })
    ).text()
    expectCurrentShape("anthropic-messages", "stream-v")
  })

  test("anthropic 非流式完成", async () => {
    setModel("claude-sonnet-4.6", "Anthropic", ["/v1/messages"])
    await (
      await app.request("/v1/messages", {
        method: "POST",
        headers: CLIENT_HEADERS,
        body: JSON.stringify({ model: "claude-sonnet-4.6", max_tokens: 256, stream: false, messages: [{ role: "user", content: "go" }] }),
      })
    ).json()
    expectCurrentShape("anthropic-messages", "json-v")
  })

  test("anthropic HTTP-错误失败(502)：outboundResponse 不回退", async () => {
    setModel("claude-sonnet-4.6", "Anthropic", ["/v1/messages"])
    failNext = true
    await (
      await app.request("/v1/messages", {
        method: "POST",
        headers: CLIENT_HEADERS,
        body: JSON.stringify({ model: "claude-sonnet-4.6", max_tokens: 256, stream: false, messages: [{ role: "user", content: "go" }] }),
      })
    )
      .text()
      .catch(() => undefined)
    const s = summarizeHttpHeaders(latest("anthropic-messages"))
    expect(s.legs).toContain("outboundResponse")
    expect(s.outboundRespUpstream).toBe("fail-v")
  })

  // ── OpenAI Chat Completions ──
  test("openai-cc 非流式完成", async () => {
    setModel("gpt-4o", "OpenAI", ["/chat/completions"])
    await (
      await app.request("/chat/completions", {
        method: "POST",
        headers: CLIENT_HEADERS,
        body: JSON.stringify({ model: "gpt-4o", stream: false, messages: [{ role: "user", content: "go" }] }),
      })
    ).json()
    expectCurrentShape("openai-chat-completions", "cc-v")
  })

  test("openai-cc HTTP-错误失败(502)", async () => {
    setModel("gpt-4o", "OpenAI", ["/chat/completions"])
    failNext = true
    await (
      await app.request("/chat/completions", {
        method: "POST",
        headers: CLIENT_HEADERS,
        body: JSON.stringify({ model: "gpt-4o", stream: false, messages: [{ role: "user", content: "go" }] }),
      })
    )
      .text()
      .catch(() => undefined)
    const s = summarizeHttpHeaders(latest("openai-chat-completions"))
    expect(s.legs).toContain("outboundResponse")
    expect(s.outboundRespUpstream).toBe("fail-v")
  })

  // ── OpenAI Responses ──
  test("openai-responses 非流式完成", async () => {
    setModel("gpt-5.5", "OpenAI", ["/chat/completions", "/responses"])
    await (
      await app.request("/responses", {
        method: "POST",
        headers: CLIENT_HEADERS,
        body: JSON.stringify({ model: "gpt-5.5", stream: false, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }] }),
      })
    ).json()
    expectCurrentShape("openai-responses", "resp-v")
  })

  test("openai-responses HTTP-错误失败(502)", async () => {
    setModel("gpt-5.5", "OpenAI", ["/chat/completions", "/responses"])
    failNext = true
    await (
      await app.request("/responses", {
        method: "POST",
        headers: CLIENT_HEADERS,
        body: JSON.stringify({ model: "gpt-5.5", stream: false, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }] }),
      })
    )
      .text()
      .catch(() => undefined)
    const s = summarizeHttpHeaders(latest("openai-responses"))
    expect(s.legs).toContain("outboundResponse")
    expect(s.outboundRespUpstream).toBe("fail-v")
  })

  // ── Gemini ──
  test("gemini 非流式完成", async () => {
    setModel("gpt-4o", "OpenAI", ["/chat/completions"])
    await (
      await app.request("/v1beta/models/gpt-4o:generateContent", {
        method: "POST",
        headers: CLIENT_HEADERS,
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "go" }] }] }),
      })
    ).json()
    expectCurrentShape("gemini-generate-content", "cc-v")
  })

  test("gemini HTTP-错误失败(502)", async () => {
    setModel("gpt-4o", "OpenAI", ["/chat/completions"])
    failNext = true
    await (
      await app.request("/v1beta/models/gpt-4o:generateContent", {
        method: "POST",
        headers: CLIENT_HEADERS,
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "go" }] }] }),
      })
    )
      .text()
      .catch(() => undefined)
    const s = summarizeHttpHeaders(latest("gemini-generate-content"))
    expect(s.legs).toContain("outboundResponse")
    expect(s.outboundRespUpstream).toBe("fail-v")
  })
})
