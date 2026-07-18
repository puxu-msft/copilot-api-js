/**
 * Responses v4 driver behavior (http + WS transports).
 *
 * Originally a v4↔legacy equivalence suite; after P3.3 deleted the legacy
 * Responses handler (and the `driver-flags` toggle), these assert the v4 driver
 * path directly. Byte-critical cases keep a golden lock captured from the driver
 * path; the rest keep their own absolute/content assertions. Covers direct
 * passthrough (streaming + non-streaming), the Responses→CC fallback, Google
 * force-fallback, stream-id-sync, normalizeCallIds, the unsupported-model reject,
 * the L2 history double-track, and the upstream-WS transport path.
 *
 * Fallback `resp_`/`item_` IDs are random (genShortId), so fallback goldens
 * normalize them before equality.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import type { RequestContext } from "~/lib/context/request"
import type {
  //
  ResponsesPayload,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import { getRequestContextManager } from "~/lib/context/manager"
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
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../helpers/mock-fetch"
import {
  //
  createSseResponse,
  createSseResponseThenAbort,
  createSseResponseThenError,
} from "../helpers/sse"

let lastResponsesWire: ResponsesPayload | undefined
let lastCcWire: { model?: string; messages?: unknown } | undefined
let respHits = 0
let throwOnce = false

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
  return text.replaceAll(/\b(resp|item)_[A-Za-z0-9]+/g, "$1_X").replaceAll(/"created_at":\d+/g, '"created_at":0')
}

describe("Responses v4 driver path", () => {
  useIsolatedRuntime()

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
    // Nothing global to restore now that the driver flag is gone.
  })

  test("direct non-streaming: client json + wire payload", async () => {
    const body = { model: "gpt-resp", input: "hi", stream: false }

    let capturedCtx: RequestContext | undefined
    const manager = getRequestContextManager()
    const originalCreate = manager.create.bind(manager)
    manager.create = (opts) => (capturedCtx = originalCreate(opts))

    const v4 = (await (await post(body)).json()) as Record<string, unknown>
    const v4Wire = lastResponsesWire

    // Byte-lock: direct passthrough renders the upstream Responses body verbatim.
    expect(v4).toEqual({
      id: "resp_up_1",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-resp",
      output: [
        { id: "item_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi there", annotations: [] }] },
      ],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
    })
    const operation = capturedCtx?.modelOperationTerminalRecord
    const clientPayload = operation?.egress?.client.payload
    const upstreamPayload = operation?.egress?.upstream.payload
    expect(operation?.arena.payloads.find((node) => node.handle === clientPayload)?.value).toEqual(v4)
    expect(operation?.arena.payloads.find((node) => node.handle === upstreamPayload)?.value).toEqual(v4)
    expect(operation?.terminal?.outcome).toBe("completed")
    expect(v4Wire?.model).toBe("gpt-resp")
    expect(v4Wire?.stream).toBe(false)
  })

  test("direct streaming: client SSE bytes", async () => {
    const body = { model: "gpt-resp", input: "hi", stream: true }

    const v4Text = await (await post(body)).text()

    expect(v4Text).toBe(responsesStreamFrames("gpt-resp").join(""))
    expect(v4Text).toContain("response.completed")
  })

  // Stage B owns-sink: the streaming outcome→ctx mapping (driver classification is locked by
  // owns-sink-two-racer.unit.test.ts; these lock the HANDLER's mapping).
  test("owns-sink streaming H3: mid-stream upstream error → entry failed + OpenAI error frame", async () => {
    setModels({ object: "list", data: [mockModel("gpt-resp", { vendor: "OpenAI", supported_endpoints: ["/responses"] })] })
    const errMock = mock(() =>
      Promise.resolve(createSseResponseThenError([responsesStreamFrames("gpt-resp")[0]], new Error("ECONNRESET: mid-stream upstream blowup"))),
    )
    applyFetchMock(errMock)

    // The disconnect diagnostic must fire on the Responses DIRECT leg too (previously only messages
    // emitted it) and carry REAL signals — one `response.created` frame arrived before the throw.
    const diagSpy = spyOn(consola, "error").mockImplementation(Object.assign(() => {}, { raw: () => {} }))
    let text: string
    try {
      text = await (
        await app.request("/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-resp", input: "hi", stream: true }),
        })
      ).text()
    } finally {
      const line = diagSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("[upstream-diagnostics] STREAM DISCONNECT"))
      diagSpy.mockRestore()
      expect(line).toBeDefined()
      expect(line).toContain("model=gpt-resp")
      expect(line).not.toContain("frames=0")
      expect(line).not.toContain("last-frame=none@0ms")
      expect(line).toContain("last-frame=response.created@")
    }

    expect(text).toContain("response.created")
    expect(text).toContain("event: error")
    expect(text).toContain('"type":"server_error"')
    expect(getHistory({ endpoint: "openai-responses" }).entries[0]?.state).toBe("failed")
  })

  test("owns-sink streaming client-abort: mid-stream disconnect → entry aborted + no error frame", async () => {
    setModels({ object: "list", data: [mockModel("gpt-resp", { vendor: "OpenAI", supported_endpoints: ["/responses"] })] })
    const clientAbort = new AbortController()
    const abortMock = mock(() => Promise.resolve(createSseResponseThenAbort([responsesStreamFrames("gpt-resp")[0]], clientAbort)))
    applyFetchMock(abortMock)

    const text = await (
      await app.request("/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-resp", input: "hi", stream: true }),
        signal: clientAbort.signal,
      })
    ).text()

    expect(text).not.toContain("event: error")
    expect(getHistory({ endpoint: "openai-responses" }).entries[0]?.state).toBe("aborted")
  })

  test("direct streaming stream-id-sync: .done id corrected to .added id", async () => {
    const body = { model: "gpt-resp", input: "hi", stream: true, __idMismatch: true }

    const v4Text = await (await post(body)).text()

    // The .done frame's id was corrected to the canonical .added id.
    expect(v4Text).toContain("oi_canonical")
    expect(v4Text).not.toContain("oi_DIFFERENT")
  })

  test("normalizeCallIds: call_ → fc_ on the direct wire", async () => {
    const body = {
      model: "gpt-resp",
      input: [
        { type: "function_call", id: "call_abc", call_id: "call_abc", name: "f", arguments: "{}" },
        { type: "function_call_output", call_id: "call_abc", output: "ok" },
      ],
      stream: false,
    }

    await post(body)
    const v4Wire = lastResponsesWire

    const items = v4Wire?.input as Array<{ call_id?: string; id?: string }>
    expect(items[0].call_id).toBe("fc_abc") // normalized
  })

  test("fallback (Responses→CC) non-streaming: client Responses json + wire is CC-shaped", async () => {
    const body = { model: "gpt-cc-only", input: "hi", stream: false }

    const v4 = normalizeIds(JSON.stringify(await (await post(body)).json()))
    const v4Wire = lastCcWire

    // Byte-lock (IDs normalized): the CC upstream body rendered back into Responses shape.
    expect(v4).toBe(
      normalizeIds(
        JSON.stringify({
          id: "resp_X",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-cc-only",
          output: [
            {
              id: "item_X",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "hi there", annotations: [] }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
          tools: [],
          tool_choice: "auto",
          parallel_tool_calls: false,
          store: false,
        }),
      ),
    )
    expect(v4Wire?.messages).toBeDefined() // Responses→CC translation happened
  })

  test("fallback streaming: client Responses SSE (full lifecycle, IDs normalized)", async () => {
    const body = { model: "gpt-cc-only", input: "hi", stream: true }

    const v4Text = normalizeIds(await (await post(body)).text())

    // Byte-lock on the CC→Responses stream translation: the FULL lifecycle event
    // sequence (the translator synthesizes created→item→content_part→delta→done→
    // completed) + the streamed text. (A literal whole-string golden is impractical
    // for 8 events; the ordered event list + content is the translation contract.)
    const eventTypes = [...v4Text.matchAll(/^event: (.+)$/gm)].map((m) => m[1])
    expect(eventTypes).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ])
    expect(v4Text).toContain('"delta":"Hello"')
    expect(v4Text).toContain('"type":"output_text","text":"Hello"')
  })

  test("Google force-fallback: routes to /chat/completions", async () => {
    const body = { model: "gemini-forced", input: "hi", stream: false }

    const v4 = normalizeIds(JSON.stringify(await (await post(body)).json()))
    const v4Wire = lastCcWire

    expect(v4Wire?.messages).toBeDefined() // forced to CC
    expect(v4).toBe(
      normalizeIds(
        JSON.stringify({
          id: "resp_X",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gemini-forced",
          output: [
            {
              id: "item_X",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "hi there", annotations: [] }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
          tools: [],
          tool_choice: "auto",
          parallel_tool_calls: false,
          store: false,
        }),
      ),
    )
  })

  test("unsupported model → 400", async () => {
    const body = { model: "claude-only", input: "hi", stream: false }

    expect((await post(body)).status).toBe(400)
  })

  test("network-retry: a transient upstream error retries once then succeeds (2 hits)", async () => {
    const body = { model: "gpt-resp", input: "hi", stream: false }

    throwOnce = true
    respHits = 0
    const v4 = (await (await post(body)).json()) as Record<string, unknown>
    expect(respHits).toBe(2)
    expect((v4 as { id?: string }).id).toBe("resp_up_1")
  })

  // R4-pre (before-first-event transport failure) — the STREAMING twin of the non-streaming
  // network-retry above. A transport error thrown BEFORE the upstream yields its first frame is
  // caught by `runExchange` (transport establishment, format-agnostic) and routed through the S4
  // strategy layer (`buildOpenAiResponsesStrategiesForEnv` → network-retry, ECONNRESET =
  // network_error), which re-exchanges once and then streams cleanly. This locks the conclusion that
  // the pre-stream transport failure is covered by the strategy layer on the HTTP path (the WS path's
  // before-first-event failure degrades to HTTP — openai-responses-client.it.test.ts "falls back to
  // HTTP before first websocket event"). No new strategy is needed; this固定s the existing coverage.
  test("R4-pre: a before-first-event transport error on a STREAMING request retries then streams to completion", async () => {
    throwOnce = true
    respHits = 0
    const text = await (await post({ model: "gpt-resp", input: "hi", stream: true })).text()

    // 2 upstream exchanges: the first throws pre-first-frame (ECONNRESET), the retry streams cleanly.
    expect(respHits).toBe(2)
    expect(text).toContain("response.created")
    expect(text).toContain("response.completed")
    // No error frame reached the client — the retry recovered transparently before any frame shipped.
    expect(text).not.toContain("event: error")
    expect(getHistory({ endpoint: "openai-responses" }).entries[0]?.state).toBe("completed")
  })

  test("history: non-streaming success finalizes the entry (completed)", async () => {
    const body = { model: "gpt-resp", input: "hi", stream: false }

    await post(body)
    const v4State = getHistory({ endpoint: "openai-responses" }).entries[0]?.state

    expect(v4State).toBe("completed")
  })

  test("history double-track (L2) direct: effective + outbound both openai-responses", async () => {
    const body = { model: "gpt-resp", input: "hi", stream: false }

    await post(body)
    const v4 = getHistory({ endpoint: "openai-responses" }).entries[0]

    expect(v4?.attempts?.at(-1)?.effectiveSource?.format).toBe("openai-responses")
    expect(v4?.attempts?.at(-1)?.effectiveSource?.model).toBe("gpt-resp")
    expect(v4?.attempts?.at(-1)?.upstreamRequest?.format).toBe("openai-responses")
    expect(typeof v4?.queueWaitMs).toBe("number")
  })

  test("history double-track (L2) fallback: effective=openai-responses, outbound=openai-chat-completions", async () => {
    const body = { model: "gpt-cc-only", input: "hi", stream: false }

    await post(body)
    const v4 = getHistory({ endpoint: "openai-responses" }).entries[0]

    expect(v4?.attempts?.at(-1)?.upstreamRequest?.format).toBe("openai-chat-completions")
    expect(v4?.attempts?.at(-1)?.effectiveSource?.format).toBe("openai-responses")
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
    dispose: async () => {},
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

describe("Responses v4 driver path — upstream WS transport", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    applyFetchMock(upstreamFetchMock)
    resetUpstreamWsManagerForTests()
    setStateForTests({ copilotToken: "tok", upstreamWebSocket: true, fixResponsesStreamIds: true, normalizeResponsesCallIds: true })
  })

  afterEach(() => {
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

  test("streaming request goes over upstream WS and forwards frames", async () => {
    const body = { model: "gpt-resp", input: "hi", stream: true }

    setUpstreamWsConnectionFactoryForTests(() => fakeWsConnection(WS_EVENTS))
    const v4Text = await (await postWs(body)).text()

    expect(v4Text).toContain("WS")
    expect(v4Text).toContain("response.completed")
  })

  test("v4 records the upstream-ws transport on the attempt", async () => {
    const body = { model: "gpt-resp", input: "hi", stream: true }

    setUpstreamWsConnectionFactoryForTests(() => fakeWsConnection(WS_EVENTS))
    await (await postWs(body)).text()

    const entry = getHistory({ endpoint: "openai-responses" }).entries[0]
    const transports = entry?.attempts?.map((a) => a.transport).filter(Boolean)
    expect(transports).toContain("upstream-ws")
  })
})
