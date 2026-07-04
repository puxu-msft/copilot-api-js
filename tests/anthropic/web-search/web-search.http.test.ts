/**
 * HTTP-level round-trip for the web_search double-hop on /v1/messages.
 *
 * Drives the real handler with a mocked upstream fetch:
 *   - first /v1/messages hop → returns a `web_search` tool_use (model decides to search)
 *   - /responses search backend → returns markdown search result text
 *   - second /v1/messages hop → returns the final answer text
 * Then asserts the synthesized client response carries the visible
 * server_tool_use + web_search_tool_result + text sequence (bypassing the
 * server-tool-filter), and that the closed state short-circuits the feature.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getEntryById } from "~/lib/history/sqlite/read"
import {
  //
  drainPendingFinalizations,
  getHistory,
  listInFlightEntries,
} from "~/lib/history/store"
import {
  //
  setModels,
  setStateForTests,
  setWebSearchConfig,
} from "~/lib/state"

import { mockModel } from "../../helpers/factories"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../../helpers/mock-fetch"
import {
  //
  createSseResponse,
  dataFramesOfType,
} from "../../helpers/sse"

// ============================================================================
// Upstream mock — routes by URL suffix, scripts the two hops + search
// ============================================================================

let messagesHits = 0
let responsesHits = 0
// Pass-through re-dispatch hits (the original request re-issued through the
// normal direct path when the probe chose not to search).
let redispatchHits = 0
// When true, the re-dispatch upstream streams a malformed embedded-signature
// thinking frame (signature on content_block_start, no signature_delta), so the
// end-to-end test can assert the direct path's thinking-signature shim repairs
// it for the client.
let redispatchThinkingStream = false
// When true, the re-dispatch upstream returns an `AskUserQuestion` tool_use whose
// `input.questions` is a STRINGIFIED JSON array AND whose items LACK `question`
// (the real GHC double-degradation). Lets the test exercise the bypass's OWN
// second decoder copy (`web-search-direct.ts` createToolInputStreamDecoder /
// decodeToolInputBlocksInResponse) — distinct from the v4 main-path S5 chain.
// Streaming vs non-streaming is chosen by the re-dispatch request's `stream` flag.
let redispatchAskUserQuestion = false
let firstHopToolUse = true
let firstHopMultiSearch = false
let firstHopStatus = 200
// When set, scripts the HTTP status of successive FIRST-hop attempts (retries).
// e.g. [400, 200] → first attempt 400 (token_limit), retry attempt 200. Consumed
// per first-hop fetch; once exhausted, falls back to `firstHopStatus`. The second
// hop + search are unaffected. Used to exercise pipeline retries (auto-truncate,
// token-refresh) on the web_search hop.
let firstHopStatusScript: Array<number> = []
let firstHopAttempts = 0
// Body returned for a scripted non-200 first-hop attempt (token_limit / auth error).
let firstHopErrorBody = JSON.stringify({ error: { message: "upstream boom", type: "api_error" } })

function firstHopBody(model: string): string {
  // First hop: the model calls the plain `web_search(query)` function tool.
  if (firstHopMultiSearch) {
    return JSON.stringify({
      id: "msg-hop1-multi",
      type: "message",
      role: "assistant",
      model,
      content: [
        { type: "tool_use", id: "toolu_a", name: "web_search", input: { query: "q1" } },
        { type: "tool_use", id: "toolu_b", name: "web_search", input: { query: "q2" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 8 },
    })
  }
  if (firstHopToolUse) {
    return JSON.stringify({
      id: "msg-hop1",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "tool_use", id: "toolu_hop1", name: "web_search", input: { query: "latest TS release" } }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 8 },
    })
  }
  // No-search branch: model answers directly.
  return JSON.stringify({
    id: "msg-direct",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "Direct answer, no search." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 6 },
  })
}

function secondHopBody(model: string): string {
  return JSON.stringify({
    id: "msg-hop2",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "TypeScript 5.9 is the latest release." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 12 },
  })
}

function responsesSearchBody(): string {
  return JSON.stringify({
    id: "resp-search",
    model: "gpt-5.5",
    output: [
      { type: "web_search_call", action: { query: "latest TypeScript release" } },
      { type: "message", content: [{ type: "output_text", text: "1. [TS 5.9 Release](https://devblogs.microsoft.com/typescript/ts-59)" }] },
    ],
    usage: { input_tokens: 200, output_tokens: 40 },
  })
}

// Streaming frames for the re-dispatch end-to-end test: the malformed
// embedded-signature thinking block (signature on content_block_start, NO
// signature_delta) — the exact upstream shape the direct path's shim repairs.
const EMBEDDED_SIG = "EoAQ-redispatch-embedded-sig"

function buildEmbeddedSigThinkingFrames(model: string): Array<string> {
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_rd",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: EMBEDDED_SIG } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer." } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    "data: [DONE]\n\n",
  ]
}

// ── AskUserQuestion decode fixture for the bypass re-dispatch path ───────────
// The real GHC degradation: `input.questions` arrives as a STRINGIFIED JSON
// array whose items ALSO lack `question` (two failures at once). Decode must
// (a) parse the string → array and (b) backfill `question = header`. This is the
// SAME input shape the v4 main-path lock uses (debug-dry-run-pipeline.http.test
// "mirrors reaped entry 1643"), so asserting the same decoded+backfilled output
// here doubles as a cross-path drift guard (T3): bypass copy ≡ main-path chain.
const ASK_QUESTIONS = [
  { header: "文件组织", multiSelect: false, options: [{ label: "只做 #1 (rename)", description: "仅 messages/handler.ts → web-search-direct.ts" }] },
]
const ASK_QUESTIONS_STRINGIFIED = JSON.stringify(ASK_QUESTIONS)
/** The decoded + header-backfilled shape the client MUST receive on the forwarded wire. */
const ASK_QUESTIONS_DECODED = ASK_QUESTIONS.map((q) => ({ ...q, question: q.header }))

/** Non-streaming AskUserQuestion re-dispatch body (questions stringified, items missing `question`). */
function redispatchAskUserQuestionBody(model: string): string {
  return JSON.stringify({
    id: "msg-rd-auq",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "tool_use", id: "toolu_auq", name: "AskUserQuestion", input: { questions: ASK_QUESTIONS_STRINGIFIED } }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  })
}

/** Streaming AskUserQuestion re-dispatch frames — one `input_json_delta` carrying the stringified questions. */
function buildAskUserQuestionFrames(model: string): Array<string> {
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_rd_auq",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_auq", name: "AskUserQuestion", input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ questions: ASK_QUESTIONS_STRINGIFIED }) } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    "data: [DONE]\n\n",
  ]
}

const upstreamFetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload =
    typeof init?.body === "string" ?
      (JSON.parse(init.body) as { model?: string; stream?: boolean; tools?: Array<{ type?: string }>; messages?: Array<{ content?: unknown }> })
    : {}
  const model = payload.model ?? "unknown"

  if (url.endsWith("/v1/messages")) {
    messagesHits += 1
    // Distinguish the calls by REQUEST FEATURES, not call order:
    //   - SECOND HOP (searched): messages include the injected tool_result turn.
    //   - PROBE (first hop): tools carry the downgraded plain `web_search(query)`
    //     function tool (toFirstHopTools strips the server `type`), so NO tool
    //     has a `type` field; messages have no tool_result.
    //   - RE-DISPATCH (pass-through) / closed-state direct: the ORIGINAL request
    //     with the native web_search server tool (has `type: web_search_*`).
    const hasToolResult = (payload.messages ?? []).some(
      (m) => Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some((b) => b.type === "tool_result"),
    )
    if (hasToolResult) return new Response(secondHopBody(model), { status: 200, headers: { "content-type": "application/json" } })

    const hasNativeWebSearchTool = (payload.tools ?? []).some((t) => typeof t.type === "string" && t.type.startsWith("web_search_"))
    if (hasNativeWebSearchTool) {
      // Re-dispatch (pass-through) or the closed-state normal path. Both forward
      // the request through the direct path; return the first-hop body verbatim.
      redispatchHits += 1
      // When exercising the corrupt-thinking fix end-to-end, the re-dispatch
      // upstream streams the malformed embedded-signature thinking frame so we
      // can assert the direct path's shim repairs it for the client.
      if (redispatchThinkingStream) {
        return createSseResponse(buildEmbeddedSigThinkingFrames(model))
      }
      // Re-dispatch returns an AskUserQuestion tool_use (stringified questions,
      // items missing `question`) so the bypass's OWN decoder copy is exercised.
      // Streaming vs non-streaming follows the re-dispatched request's own flag.
      if (redispatchAskUserQuestion) {
        return payload.stream ?
            createSseResponse(buildAskUserQuestionFrames(model))
          : new Response(redispatchAskUserQuestionBody(model), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response(firstHopBody(model), { status: 200, headers: { "content-type": "application/json" } })
    }

    // Probe (downgraded tools, no tool_result). May retry via the pipeline
    // (auto-truncate / token-refresh) before returning 200.
    firstHopAttempts += 1
    const scripted = firstHopStatusScript.length > 0 ? firstHopStatusScript.shift()! : firstHopStatus
    if (scripted !== 200) {
      return new Response(firstHopErrorBody, { status: scripted, headers: { "content-type": "application/json" } })
    }
    return new Response(firstHopBody(model), { status: 200, headers: { "content-type": "application/json" } })
  }

  if (url.endsWith("/responses")) {
    responsesHits += 1
    return new Response(responsesSearchBody(), { status: 200, headers: { "content-type": "application/json" } })
  }

  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../../helpers/test-app")
const app = createFullTestApp()

interface SynthesizedBody {
  id: string
  type: string
  model: string
  content: Array<Record<string, unknown>>
  usage: Record<string, unknown>
}

const webSearchTool = { name: "web_search", type: "web_search_20250305", max_uses: 5 }

describe("POST /v1/messages — web_search double-hop", () => {
  useIsolatedRuntime()
  // Restore state after each test — these tests mutate decode/backfill config and
  // bun runs the whole suite in one process (global singleton leaks across files).

  beforeEach(() => {
    messagesHits = 0
    responsesHits = 0
    redispatchHits = 0
    redispatchThinkingStream = false
    redispatchAskUserQuestion = false
    firstHopToolUse = true
    firstHopMultiSearch = false
    firstHopStatus = 200
    firstHopStatusScript = []
    firstHopAttempts = 0
    firstHopErrorBody = JSON.stringify({ error: { message: "upstream boom", type: "api_error" } })
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
      data: [mockModel("claude-opus-4.6", { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })],
    })
    setWebSearchConfig({ webSearchEnabled: true, webSearchBackend: "gpt-5.5" })
  })

  test("synthesizes a response with visible server_tool_use + web_search_tool_result + text", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "What is the latest TypeScript release?" }],
        max_tokens: 256,
        tools: [webSearchTool],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as SynthesizedBody

    // Two model hops + one search sub-request.
    expect(messagesHits).toBe(2)
    expect(responsesHits).toBe(1)

    // Block sequence is visible to the client (NOT filtered by server-tool-filter).
    const types = body.content.map((b) => b.type)
    expect(types).toEqual(["server_tool_use", "web_search_tool_result", "text"])

    expect(body.content[0]).toMatchObject({ type: "server_tool_use", name: "web_search" })
    const toolResult = body.content[1]
    expect(toolResult.type).toBe("web_search_tool_result")
    const resultItems = toolResult.content as Array<Record<string, unknown>>
    expect(resultItems[0]).toMatchObject({ type: "web_search_result", url: "https://devblogs.microsoft.com/typescript/ts-59" })
    expect(body.content[2]).toEqual({ type: "text", text: "TypeScript 5.9 is the latest release." })

    // Merged usage across hops + search.
    expect(body.usage.server_tool_use).toEqual({ web_search_requests: 1 })
  })

  test("streaming path emits the synthesized SSE sequence", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "latest TS?" }],
        max_tokens: 256,
        tools: [webSearchTool],
        stream: true,
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    // A `ping` is emitted first (flushes headers + resets the client idle clock
    // before the two hops + search run) — M1: it must precede message_start.
    expect(text).toContain("event: ping")
    expect(text.indexOf("event: ping")).toBeLessThan(text.indexOf("event: message_start"))
    expect(text).toContain("event: message_start")
    expect(text).toContain('"type":"server_tool_use"')
    expect(text).toContain('"type":"web_search_tool_result"')
    expect(text).toContain("event: message_stop")
    expect(messagesHits).toBe(2)
    expect(responsesHits).toBe(1)
  })

  test("pass-through (first hop without a search) re-dispatches through the normal direct path", async () => {
    firstHopToolUse = false
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 256,
        tools: [webSearchTool],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as SynthesizedBody
    // The client receives the direct path's answer, NOT a synthesized one.
    expect(body.content).toEqual([{ type: "text", text: "Direct answer, no search." }])
    // Probe (downgraded tool) + re-dispatch (original native web_search tool).
    expect(messagesHits).toBe(2)
    expect(redispatchHits).toBe(1)
    expect(responsesHits).toBe(0) // no search ran
  })

  test("pass-through + streaming: corrupt-thinking is FIXED — re-dispatch runs the direct path's signature shim", async () => {
    // This is the direct end-to-end proof of the bug fix: web_search is on,
    // Claude Code declares WebSearch, the probe does NOT search, so the request
    // re-dispatches through the direct path. The re-dispatch upstream streams the
    // malformed embedded-signature thinking frame; the client MUST receive a
    // synthesized signature_delta (the shim ran) and NEVER the embedded-sig start.
    firstHopToolUse = false
    redispatchThinkingStream = true
    setStateForTests({ thinkingSignatureCompat: "signature_delta" })

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "think then answer" }],
        max_tokens: 256,
        tools: [webSearchTool],
        stream: true,
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()

    // The thinking content_block_start the client gets must NOT carry the signature inline.
    const thinkingStarts = dataFramesOfType(text, "content_block_start").filter((f) => (f.content_block as Record<string, unknown>).type === "thinking")
    expect(thinkingStarts).toHaveLength(1)
    expect((thinkingStarts[0].content_block as Record<string, unknown>).signature).toBe("")

    // A synthesized signature_delta carrying the signature must be present (proves the shim ran).
    const sigDeltas = dataFramesOfType(text, "content_block_delta").filter((f) => (f.delta as Record<string, unknown>).type === "signature_delta")
    expect(sigDeltas).toHaveLength(1)
    expect((sigDeltas[0].delta as Record<string, unknown>).signature).toBe(EMBEDDED_SIG)

    // Real token-by-token streaming survived (text forwarded), and it went through
    // the direct path (probe + re-dispatch).
    expect(text).toContain("Answer.")
    expect(messagesHits).toBe(2)
    expect(redispatchHits).toBe(1)
    expect(responsesHits).toBe(0)

    // History records a single entry whose forwarded SSE contains the shim's
    // signature_delta (proves the request was served by processOneStreamEvent).
    const entry = getHistory({ endpoint: "anthropic-messages", limit: 5 }).entries[0]
    expect(entry).toBeDefined()
    const fwdHasSigDelta = (entry.inboundResponse?.sseEvents ?? [])
      .map((e) => safeParse(e.raw))
      .some((x) => (x?.delta as Record<string, unknown> | undefined)?.type === "signature_delta")
    expect(fwdHasSigDelta).toBe(true)
    // The pass-through probe's token cost is surfaced as a warning (原则3).
    expect((entry.warningMessages ?? []).some((w) => w.code === "web_search_probe")).toBe(true)

    // PERSISTENCE GUARD: assert the SQLite-PERSISTED row is complete after a
    // re-dispatch. getHistory returns the in-flight entry first, so this uses
    // getEntryById (which reassembles the head row + entry_stages sub-rows) to
    // verify the heavy fields (inboundRequest / sseEvents / inboundResponse /
    // outboundResponse — all stored as STAGE_TOP_KEYS in entry_stages, not the
    // head blob) survive finalization for the re-dispatch path.
    // Finalize is async now (libuv-offloaded compression) — drain it before asserting.
    await drainPendingFinalizations()
    expect(listInFlightEntries().some((e) => e.id === entry.id)).toBe(false) // finalized
    const persisted = getEntryById(entry.id)
    expect(persisted).toBeDefined()
    expect(persisted!.inboundRequest?.messages?.length ?? 0).toBeGreaterThan(0)
    expect((persisted!.sseEvents ?? []).length).toBeGreaterThan(0)
    expect((persisted!.inboundResponse?.sseEvents ?? []).length).toBeGreaterThan(0)
    expect(persisted!.outboundResponse).toBeDefined()
  })

  test("bypass decode (streaming): re-dispatch AskUserQuestion is decoded + header-backfilled on the forwarded stream", async () => {
    // The bypass (web-search-direct.ts) carries its OWN decoder copy, independent
    // of the v4 main-path S5 chain. Drive it via the pass-through re-dispatch
    // (probe does NOT search → handleDirectAnthropicCompletion → streaming pump →
    // createToolInputStreamDecoder). Assert the client receives a DECODED array
    // with `question` backfilled, while history keeps the upstream stringified form.
    firstHopToolUse = false // probe answers directly → pass-through re-dispatch
    redispatchAskUserQuestion = true // re-dispatch upstream emits the AskUserQuestion degradation
    setStateForTests({ decodeToolInputFields: { AskUserQuestion: ["questions"] }, decodeAllToolInputFields: false, backfillQuestionFromHeader: true })

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "ask me something" }],
        max_tokens: 256,
        tools: [webSearchTool],
        stream: true,
      }),
    })

    expect(res.status).toBe(200)
    const text = await res.text()
    // Forwarded (client-received): questions decoded to an array AND each item backfilled.
    expect(questionsFromFrames(rawDataLines(text))).toEqual(ASK_QUESTIONS_DECODED)
    // Went through the direct path (probe + re-dispatch), no search.
    expect(messagesHits).toBe(2)
    expect(redispatchHits).toBe(1)
    expect(responsesHits).toBe(0)

    // History: forwarded (inboundResponse.sseEvents) decoded; upstream-raw (top-level
    // sseEvents) keeps the stringified form (richest-data-flow: decode touches only
    // the forwarded wire, history preserves the upstream anomaly verbatim).
    const entry = getHistory({ endpoint: "anthropic-messages", limit: 5 }).entries[0]
    expect(entry).toBeDefined()
    expect(questionsFromFrames((entry.inboundResponse?.sseEvents ?? []).map((e) => e.raw))).toEqual(ASK_QUESTIONS_DECODED)
    const upstreamQuestions = questionsFromFrames((entry.sseEvents ?? []).map((e) => e.raw))
    expect(typeof upstreamQuestions).toBe("string") // NOT decoded in history
    expect(upstreamQuestions).toBe(ASK_QUESTIONS_STRINGIFIED)
  })

  test("bypass decode (non-streaming): re-dispatch AskUserQuestion is decoded + header-backfilled on the forwarded JSON", async () => {
    // Same bypass copy, non-streaming branch: handleDirectAnthropicNonStreamingResponse
    // → decodeToolInputBlocksInResponse. Client JSON must carry the decoded+backfilled
    // input; history's outboundResponse (upstream-original) keeps the stringified form.
    firstHopToolUse = false
    redispatchAskUserQuestion = true
    setStateForTests({ decodeToolInputFields: { AskUserQuestion: ["questions"] }, decodeAllToolInputFields: false, backfillQuestionFromHeader: true })

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "ask me something" }],
        max_tokens: 256,
        tools: [webSearchTool],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as SynthesizedBody
    // Forwarded (client JSON): decoded array WITH question backfilled.
    expect(askUserQuestionInput(body.content)?.questions).toEqual(ASK_QUESTIONS_DECODED)
    expect(messagesHits).toBe(2)
    expect(redispatchHits).toBe(1)
    expect(responsesHits).toBe(0)

    // History: forwarded (inboundResponse) decoded; upstream-original (outboundResponse) stringified.
    const entry = getHistory({ endpoint: "anthropic-messages", limit: 5 }).entries[0]
    expect(entry).toBeDefined()
    const fwdContent = (entry.inboundResponse?.content as { content?: Array<Record<string, unknown>> } | undefined)?.content ?? []
    expect(askUserQuestionInput(fwdContent)?.questions).toEqual(ASK_QUESTIONS_DECODED)
    const upstreamContent = (entry.outboundResponse?.content as { content?: Array<Record<string, unknown>> } | null)?.content ?? []
    expect(typeof askUserQuestionInput(upstreamContent)?.questions).toBe("string") // NOT decoded in history
    expect(askUserQuestionInput(upstreamContent)?.questions).toBe(ASK_QUESTIONS_STRINGIFIED)
  })

  test("closed state (webSearchEnabled=false) short-circuits — request goes through the normal path", async () => {
    setWebSearchConfig({ webSearchEnabled: false, webSearchBackend: "gpt-5.5" })
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "latest TS?" }],
        max_tokens: 256,
        tools: [webSearchTool],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    // Normal path makes exactly one upstream call and no search; the orchestrator never runs.
    expect(messagesHits).toBe(1)
    expect(responsesHits).toBe(0)
    const body = (await res.json()) as SynthesizedBody
    // First-hop body is returned verbatim (the normal path forwards upstream as-is,
    // server-tool-filter strips nothing here since there are no server blocks).
    expect(body.content[0]).toMatchObject({ type: "tool_use", name: "web_search" })
  })

  test("hard first-hop failure: non-streaming surfaces an error status (reqCtx.fail + rethrow path)", async () => {
    firstHopStatus = 500
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "latest TS?" }],
        max_tokens: 256,
        tools: [webSearchTool],
        stream: false,
      }),
    })

    // The double-hop's first model call failed → the handler's catch marks the
    // request failed and rethrows; the route surfaces a non-2xx to the client.
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(messagesHits).toBe(1) // failed on hop 1, no second hop or search
    expect(responsesHits).toBe(0)
  })

  test("hard first-hop (probe) failure: surfaced as an HTTP error before any stream is opened", async () => {
    firstHopStatus = 500
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "latest TS?" }],
        max_tokens: 256,
        tools: [webSearchTool],
        stream: true,
      }),
    })

    // The probe runs BEFORE the SSE stream is opened (so a no-search outcome can
    // re-dispatch). A probe failure therefore happens before any client bytes
    // are owed and is surfaced as a clean HTTP error status — not a fake-200
    // with an in-stream error event (the old behavior, when the ping was sent
    // before the first hop). Cleaner: no headers committed yet.
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(messagesHits).toBe(1) // failed on the probe, no second hop or search
    expect(responsesHits).toBe(0)
  })

  test("multiple parallel searches: still synthesizes a valid response (M3 dropped-search path)", async () => {
    firstHopMultiSearch = true
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4.6",
        messages: [{ role: "user", content: "latest TS?" }],
        max_tokens: 256,
        tools: [webSearchTool],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as SynthesizedBody
    // Acts on the first search only (round limit 1); the extra is dropped+warned
    // but the response is still a complete, valid synthesized sequence.
    expect(body.content.map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result", "text"])
    expect(messagesHits).toBe(2) // first hop (multi) + second hop
    expect(responsesHits).toBe(1) // exactly one search executed
  })

  // ── Pipeline integration: the web_search hops now run through executeRequestPipeline ──

  test("auto-truncate: first hop 400 token_limit triggers truncation + retry, then succeeds", async () => {
    setStateForTests({ autoTruncate: true })
    // First hop: 400 token-limit, then 200 on the truncated retry.
    firstHopStatusScript = [400, 200]
    firstHopErrorBody = JSON.stringify({
      error: { code: "model_max_prompt_tokens_exceeded", message: "prompt is too long: 200000 tokens > 100000 maximum", type: "invalid_request_error" },
    })
    // A large message array so auto-truncate has something to remove (above the
    // reported 100000 limit × 0.9 target once converted to gpt caliber).
    const messages = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(8000) }))

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4.6", messages, max_tokens: 256, tools: [webSearchTool], stream: false }),
    })

    expect(res.status).toBe(200)
    // First hop was attempted twice (400 → truncate → retry 200), proving the
    // hop ran through the retry pipeline (the whole point of this fix).
    expect(firstHopAttempts).toBe(2)
    // Then the second hop + search ran normally → full synthesized response.
    const body = (await res.json()) as SynthesizedBody
    expect(body.content.map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result", "text"])
    expect(responsesHits).toBe(1)
  })

  test("auto-truncate DISABLED: first hop 400 token_limit passes through (no retry, no synthesis)", async () => {
    setStateForTests({ autoTruncate: false })
    firstHopStatusScript = [400]
    firstHopErrorBody = JSON.stringify({
      error: { code: "model_max_prompt_tokens_exceeded", message: "prompt is too long: 200000 tokens > 100000 maximum", type: "invalid_request_error" },
    })
    const messages = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(8000) }))

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4.6", messages, max_tokens: 256, tools: [webSearchTool], stream: false }),
    })

    // auto-truncate off → strategy short-circuits → 400 propagates, hop fails.
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(firstHopAttempts).toBe(1) // no retry
    expect(responsesHits).toBe(0) // never reached the search
  })
})

/** Parse an SSE `data:` payload to an object, or undefined when not JSON. */
function safeParse(raw: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Collect the raw `data:` JSON strings (excluding `[DONE]`) from a forwarded SSE text. */
function rawDataLines(sse: string): Array<string> {
  const out: Array<string> = []
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const body = line.slice(6)
    if (body === "[DONE]") continue
    out.push(body)
  }
  return out
}

/**
 * Reassemble a tool_use block's `questions` value from a list of SSE frame raw JSON
 * strings, by joining its `input_json_delta` fragments and parsing. Returns the
 * decoded array on the forwarded wire, or the still-stringified value in upstream history.
 */
function questionsFromFrames(rawFrames: Array<string>): unknown {
  const chunks: Array<string> = []
  for (const raw of rawFrames) {
    const p = safeParse(raw)
    const delta = p?.delta as { type?: string; partial_json?: string } | undefined
    if (p?.type === "content_block_delta" && delta?.type === "input_json_delta") chunks.push(delta.partial_json ?? "")
  }
  return (JSON.parse(chunks.join("")) as { questions?: unknown }).questions
}

/** Find the `AskUserQuestion` tool_use block's `input` in a non-streaming content array. */
function askUserQuestionInput(content: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  const block = content.find((b) => b.type === "tool_use" && b.name === "AskUserQuestion")
  return block?.input as Record<string, unknown> | undefined
}
