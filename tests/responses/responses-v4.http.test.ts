/**
 * P2.4 — Responses v4 driver ↔ legacy equivalence (http + WS transports).
 *
 * Runs the same request through the legacy handler (flag off) and the v4 driver
 * path (flag on) against the same mocked upstream, asserting the client-facing
 * output + the outbound wire payload match. Covers direct passthrough
 * (streaming + non-streaming), the Responses→CC fallback, Google force-fallback,
 * stream-id-sync, normalizeCallIds, the unsupported-model reject, the L2 history
 * double-track, and the upstream-WS transport path.
 *
 * Fallback `resp_`/`item_` IDs are random (genShortId), so fallback comparisons
 * normalize them before equality.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type {
  //
  ResponsesPayload,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import {
  //
  isV4DriverEnabled,
  setV4DriverEnabled,
} from "~/lib/codec/driver-flags"
import { getHistory } from "~/lib/history"
import {
  //
  resetUpstreamWsManagerForTests,
  setUpstreamWsConnectionFactoryForTests,
} from "~/lib/openai/upstream-ws"
import {
  //
  setDisabledModels,
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import {
  //
  applyFetchMock,
  autoRestoreFetch,
} from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"
import { autoTestRuntime } from "../helpers/test-bootstrap"

let lastResponsesWire: ResponsesPayload | undefined
let lastCcWire: { model?: string; messages?: unknown } | undefined
let respHits = 0
let throwOnce = false

const DEFAULT_V4_FLAG = isV4DriverEnabled("openai-responses")

// ── upstream response factories ─────────────────────────────────────────────

function responsesNonStream(model: string): Response {
  return new Response(
    JSON.stringify({
      id: "resp_up_1",
      object: "response",
      created_at: 1,
      status: "completed",
      model,
      output: [
        { id: "item_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi there", annotations: [] }] },
      ],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function responsesStreamFrames(model: string): Array<string> {
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "resp_up_1", object: "response", created_at: 1, status: "in_progress", model, output: [], usage: null, tools: [], tool_choice: "auto", parallel_tool_calls: false, store: false } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 1, output_index: 0, content_index: 0, delta: "Hi" })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 2, response: { id: "resp_up_1", object: "response", created_at: 1, status: "completed", model, output: [], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }, tools: [], tool_choice: "auto", parallel_tool_calls: false, store: false } })}\n\n`,
  ]
}

/** Direct stream with an output_item.added(id=A) + .done(id=B) mismatch → stream-id-sync corrects .done to A. */
function responsesStreamIdMismatchFrames(model: string): Array<string> {
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "resp_up_1", status: "in_progress", model, output: [] } })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { id: "oi_canonical", type: "message", role: "assistant", status: "in_progress", content: [] } })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", sequence_number: 2, output_index: 0, item: { id: "oi_DIFFERENT", type: "message", role: "assistant", status: "completed", content: [] } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 3, response: { id: "resp_up_1", status: "completed", model, output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
  ]
}

function ccNonStream(model: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function ccStreamFrames(model: string): Array<string> {
  return [
    `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null, logprobs: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }] })}\n\n`,
    "data: [DONE]\n\n",
  ]
}

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? JSON.parse(init.body) : {}

  if (url.endsWith("/responses")) {
    lastResponsesWire = payload as ResponsesPayload
    respHits += 1
    if (throwOnce) {
      throwOnce = false
      throw new Error("ECONNRESET: upstream socket reset")
    }
    if (payload.stream) {
      const frames = payload.__idMismatch ? responsesStreamIdMismatchFrames(payload.model) : responsesStreamFrames(payload.model)
      return Promise.resolve(createSseResponse(frames))
    }
    return Promise.resolve(responsesNonStream(payload.model))
  }
  if (url.endsWith("/chat/completions")) {
    lastCcWire = payload as { model?: string; messages?: unknown }
    if (payload.stream) return Promise.resolve(createSseResponse(ccStreamFrames(payload.model)))
    return Promise.resolve(ccNonStream(payload.model))
  }
  throw new Error(`unexpected upstream URL: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

function injectModels(): void {
  setDisabledModels([])
  setModels({
    object: "list",
    data: [
      mockModel("gpt-resp", { vendor: "OpenAI", supported_endpoints: ["/responses"] }),
      mockModel("gpt-cc-only", { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] }),
      mockModel("gemini-forced", { vendor: "Google", supported_endpoints: ["/responses"] }),
      mockModel("claude-only", { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] }),
    ],
  })
}

async function post(body: unknown): Promise<Response> {
  injectModels()
  return app.request("/responses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
}

/** Normalize random fallback resp_/item_ IDs so legacy ↔ v4 comparisons are stable. */
function normalizeIds(text: string): string {
  return text.replaceAll(/\b(resp|item)_[A-Za-z0-9]+/g, "$1_X")
}

describe("Responses v4 ↔ legacy equivalence", () => {
  autoTestRuntime()
  autoRestoreFetch()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    lastResponsesWire = undefined
    lastCcWire = undefined
    respHits = 0
    throwOnce = false
    applyFetchMock(upstreamFetchMock)
    setStateForTests({ copilotToken: "tok", normalizeResponsesCallIds: true, fixResponsesStreamIds: true, upstreamWebSocket: false })
  })

  afterEach(() => {
    setV4DriverEnabled("openai-responses", DEFAULT_V4_FLAG)
  })

  test("direct non-streaming: client json + wire payload equal", async () => {
    const body = { model: "gpt-resp", input: "hi", stream: false }

    setV4DriverEnabled("openai-responses", false)
    const legacy = (await (await post(body)).json()) as Record<string, unknown>
    const legacyWire = lastResponsesWire

    setV4DriverEnabled("openai-responses", true)
    const v4 = (await (await post(body)).json()) as Record<string, unknown>
    const v4Wire = lastResponsesWire

    expect(v4).toEqual(legacy)
    expect(v4Wire).toEqual(legacyWire)
  })

  test("direct streaming: client SSE bytes equal", async () => {
    const body = { model: "gpt-resp", input: "hi", stream: true }

    setV4DriverEnabled("openai-responses", false)
    const legacyText = await (await post(body)).text()

    setV4DriverEnabled("openai-responses", true)
    const v4Text = await (await post(body)).text()

    expect(v4Text).toBe(legacyText)
    expect(v4Text).toContain("response.completed")
  })

  test("direct streaming stream-id-sync: .done id corrected to .added id (both paths equal)", async () => {
    const body = { model: "gpt-resp", input: "hi", stream: true, __idMismatch: true }

    setV4DriverEnabled("openai-responses", false)
    const legacyText = await (await post(body)).text()

    setV4DriverEnabled("openai-responses", true)
    const v4Text = await (await post(body)).text()

    expect(v4Text).toBe(legacyText)
    // The .done frame's id was corrected to the canonical .added id.
    expect(v4Text).toContain("oi_canonical")
    expect(v4Text).not.toContain("oi_DIFFERENT")
  })

  test("normalizeCallIds: call_ → fc_ on the direct wire (both paths equal)", async () => {
    const body = {
      model: "gpt-resp",
      input: [
        { type: "function_call", id: "call_abc", call_id: "call_abc", name: "f", arguments: "{}" },
        { type: "function_call_output", call_id: "call_abc", output: "ok" },
      ],
      stream: false,
    }

    setV4DriverEnabled("openai-responses", false)
    await post(body)
    const legacyWire = lastResponsesWire

    setV4DriverEnabled("openai-responses", true)
    await post(body)
    const v4Wire = lastResponsesWire

    expect(v4Wire).toEqual(legacyWire)
    const items = v4Wire?.input as Array<{ call_id?: string; id?: string }>
    expect(items[0].call_id).toBe("fc_abc") // normalized
  })

  test("fallback (Responses→CC) non-streaming: client Responses json equal + wire is CC-shaped", async () => {
    const body = { model: "gpt-cc-only", input: "hi", stream: false }

    setV4DriverEnabled("openai-responses", false)
    const legacy = normalizeIds(JSON.stringify(await (await post(body)).json()))
    const legacyWire = lastCcWire

    setV4DriverEnabled("openai-responses", true)
    const v4 = normalizeIds(JSON.stringify(await (await post(body)).json()))
    const v4Wire = lastCcWire

    expect(v4).toBe(legacy)
    expect(v4Wire?.messages).toBeDefined() // Responses→CC translation happened
    expect(v4Wire).toEqual(legacyWire)
  })

  test("fallback streaming: client Responses SSE equal (IDs normalized)", async () => {
    const body = { model: "gpt-cc-only", input: "hi", stream: true }

    setV4DriverEnabled("openai-responses", false)
    const legacyText = normalizeIds(await (await post(body)).text())

    setV4DriverEnabled("openai-responses", true)
    const v4Text = normalizeIds(await (await post(body)).text())

    expect(v4Text).toBe(legacyText)
    expect(v4Text).toContain("response.completed")
  })

  test("Google force-fallback: routes to /chat/completions on both paths", async () => {
    const body = { model: "gemini-forced", input: "hi", stream: false }

    setV4DriverEnabled("openai-responses", false)
    const legacy = normalizeIds(JSON.stringify(await (await post(body)).json()))
    const legacyWire = lastCcWire

    setV4DriverEnabled("openai-responses", true)
    const v4 = normalizeIds(JSON.stringify(await (await post(body)).json()))
    const v4Wire = lastCcWire

    expect(v4Wire?.messages).toBeDefined() // forced to CC
    expect(v4).toBe(legacy)
    expect(v4Wire).toEqual(legacyWire)
  })

  test("unsupported model → 400 on both paths", async () => {
    const body = { model: "claude-only", input: "hi", stream: false }

    setV4DriverEnabled("openai-responses", false)
    expect((await post(body)).status).toBe(400)

    setV4DriverEnabled("openai-responses", true)
    expect((await post(body)).status).toBe(400)
  })

  test("network-retry: a transient upstream error retries once then succeeds (both paths, 2 hits)", async () => {
    const body = { model: "gpt-resp", input: "hi", stream: false }

    setV4DriverEnabled("openai-responses", false)
    throwOnce = true
    respHits = 0
    const legacy = (await (await post(body)).json()) as Record<string, unknown>
    expect(respHits).toBe(2)

    setV4DriverEnabled("openai-responses", true)
    throwOnce = true
    respHits = 0
    const v4 = (await (await post(body)).json()) as Record<string, unknown>
    expect(respHits).toBe(2)
    expect(v4).toEqual(legacy)
  })

  test("history: non-streaming success finalizes the entry (completed) on both paths", async () => {
    const body = { model: "gpt-resp", input: "hi", stream: false }

    setV4DriverEnabled("openai-responses", false)
    await post(body)
    const legacyState = getHistory({ endpoint: "openai-responses" }).entries[0]?.state

    setV4DriverEnabled("openai-responses", true)
    await post(body)
    const v4State = getHistory({ endpoint: "openai-responses" }).entries[0]?.state

    expect(legacyState).toBe("completed")
    expect(v4State).toBe("completed")
  })

  test("history double-track (L2) direct: effective + outbound both openai-responses, equal to legacy", async () => {
    const body = { model: "gpt-resp", input: "hi", stream: false }

    setV4DriverEnabled("openai-responses", false)
    await post(body)
    const legacy = getHistory({ endpoint: "openai-responses" }).entries[0]

    setV4DriverEnabled("openai-responses", true)
    await post(body)
    const v4 = getHistory({ endpoint: "openai-responses" }).entries[0]

    expect(v4?.effectiveRequest?.format).toBe(legacy?.effectiveRequest?.format)
    expect(v4?.effectiveRequest?.format).toBe("openai-responses")
    expect(v4?.effectiveRequest?.model).toBe(legacy?.effectiveRequest?.model)
    expect(v4?.outboundRequest?.format).toBe(legacy?.outboundRequest?.format)
    expect(v4?.outboundRequest?.format).toBe("openai-responses")
    expect(v4?.outboundRequest?.messageCount).toBe(legacy?.outboundRequest?.messageCount)
    expect(typeof v4?.queueWaitMs).toBe("number")
  })

  test("history double-track (L2) fallback: effective=openai-responses, outbound=openai-chat-completions, equal to legacy", async () => {
    const body = { model: "gpt-cc-only", input: "hi", stream: false }

    setV4DriverEnabled("openai-responses", false)
    await post(body)
    const legacy = getHistory({ endpoint: "openai-responses" }).entries[0]

    setV4DriverEnabled("openai-responses", true)
    await post(body)
    const v4 = getHistory({ endpoint: "openai-responses" }).entries[0]

    expect(legacy?.outboundRequest?.format).toBe("openai-chat-completions")
    expect(v4?.outboundRequest?.format).toBe("openai-chat-completions")
    expect(v4?.effectiveRequest?.format).toBe("openai-responses")
    expect(v4?.outboundRequest?.messageCount).toBe(legacy?.outboundRequest?.messageCount)
    expect(v4?.effectiveRequest?.messageCount).toBe(legacy?.effectiveRequest?.messageCount)
  })
})

// ── Upstream WS transport path ──────────────────────────────────────────────

/** A fake upstream WS connection whose sendRequest yields the given Responses events. */
function fakeWsConnection(events: Array<ResponsesStreamEvent>) {
  let open = false
  return {
    connect: () => {
      open = true
      return Promise.resolve()
    },
    sendRequest: () =>
      (async function* (): AsyncGenerator<ResponsesStreamEvent> {
        for (const ev of events) yield ev
      })(),
    get isOpen() {
      return open
    },
    get isBusy() {
      return false
    },
    statefulMarker: undefined,
    model: "gpt-resp",
    conversationId: undefined,
    handshakeHeaders: {},
    close: () => {},
  }
}

const WS_EVENTS: Array<ResponsesStreamEvent> = [
  {
    type: "response.created",
    sequence_number: 0,
    response: {
      id: "resp_ws",
      object: "response",
      created_at: 1,
      status: "in_progress",
      model: "gpt-resp",
      output: [],
      usage: null,
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
    },
  } as unknown as ResponsesStreamEvent,
  { type: "response.output_text.delta", sequence_number: 1, output_index: 0, content_index: 0, delta: "WS" } as unknown as ResponsesStreamEvent,
  {
    type: "response.completed",
    sequence_number: 2,
    response: {
      id: "resp_ws",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-resp",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
    },
  } as unknown as ResponsesStreamEvent,
]

describe("Responses v4 ↔ legacy equivalence — upstream WS transport", () => {
  autoTestRuntime()
  autoRestoreFetch()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    applyFetchMock(upstreamFetchMock)
    resetUpstreamWsManagerForTests()
    setStateForTests({ copilotToken: "tok", upstreamWebSocket: true, fixResponsesStreamIds: true, normalizeResponsesCallIds: true })
  })

  afterEach(() => {
    setV4DriverEnabled("openai-responses", DEFAULT_V4_FLAG)
    setUpstreamWsConnectionFactoryForTests(null)
    resetUpstreamWsManagerForTests()
  })

  function injectWsModel(): void {
    setDisabledModels([])
    setModels({ object: "list", data: [mockModel("gpt-resp", { vendor: "OpenAI", supported_endpoints: ["/responses", "ws:/responses"] })] })
  }

  async function postWs(body: unknown): Promise<Response> {
    injectWsModel()
    return app.request("/responses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  }

  test("streaming request goes over upstream WS and forwards frames (both paths equal)", async () => {
    const body = { model: "gpt-resp", input: "hi", stream: true }

    setUpstreamWsConnectionFactoryForTests(() => fakeWsConnection(WS_EVENTS))
    setV4DriverEnabled("openai-responses", false)
    const legacyText = await (await postWs(body)).text()

    resetUpstreamWsManagerForTests()
    setUpstreamWsConnectionFactoryForTests(() => fakeWsConnection(WS_EVENTS))
    setV4DriverEnabled("openai-responses", true)
    const v4Text = await (await postWs(body)).text()

    expect(v4Text).toBe(legacyText)
    expect(v4Text).toContain("WS")
    expect(v4Text).toContain("response.completed")
  })

  test("v4 records the upstream-ws transport on the attempt", async () => {
    const body = { model: "gpt-resp", input: "hi", stream: true }

    setUpstreamWsConnectionFactoryForTests(() => fakeWsConnection(WS_EVENTS))
    setV4DriverEnabled("openai-responses", true)
    await (await postWs(body)).text()

    const entry = getHistory({ endpoint: "openai-responses" }).entries[0]
    const transports = entry?.attempts?.map((a) => a.transport).filter(Boolean)
    expect(transports).toContain("upstream-ws")
  })
})
