/**
 * P2.6 — Anthropic /v1/messages v4 driver ↔ legacy equivalence (http).
 *
 * Runs the same request through the legacy `handleMessages` (flag off) and the
 * v4 driver `handleMessagesV4` (flag on) against the same mocked upstream,
 * asserting the client-facing output + the outbound wire payload match. The
 * Anthropic codec's translate/render are identity (bypass-direct), so the driver
 * forwards the upstream Anthropic SSE frames byte-for-byte; the equivalence here
 * therefore exercises the byte-critical pump primitives (streaming-pump.ts) and
 * the legacy non-streaming finishing reused by handler-v4.
 *
 * Covers the v4-specific divergence points the wide-oracle (whole suite re-run
 * with the flag on) does NOT assert as v4-vs-legacy: direct stream/non-stream
 * byte equivalence, thinking-signature round-trip, tool-name sanitize→restore,
 * network-retry, the L2 history double-track, the reject → `failed` finalization
 * (under a production-faithful app that installs observabilityMiddleware), and
 * H2 (a terminal upstream `error` SSE frame → forwarded once → ctx.fail, NOT a
 * thrown 500 like the OpenAI paths).
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
import { Hono } from "hono"

import { resetAnthropicFeatureNegotiationForTesting } from "~/lib/anthropic/feature-negotiation"
import {
  //
  isV4DriverEnabled,
  setV4DriverEnabled,
} from "~/lib/codec/driver-flags"
import { forwardError } from "~/lib/error"
import { getHistory } from "~/lib/history"
import { observabilityMiddleware } from "~/lib/observability/middleware"
import {
  //
  setModelOverrides,
  setModels,
  setStateForTests,
} from "~/lib/state"
import { registerHttpRoutes } from "~/routes"

import { mockModel } from "../helpers/factories"
import {
  //
  applyFetchMock,
  autoRestoreFetch,
} from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"
import { autoTestRuntime } from "../helpers/test-bootstrap"

type Scenario = "ok" | "thinking" | "errorFrame" | "midStreamThrow" | "deferredTool"

let messagesHits = 0
let capturedWire: { model?: string; stream?: boolean; messages?: Array<unknown>; tools?: Array<{ name?: string }> } | undefined
let throwOnce = false
let scenario: Scenario = "ok"

const DEFAULT_V4_FLAG = isV4DriverEnabled("anthropic")

// ── upstream response factories ─────────────────────────────────────────────

function nonStreamingBody(model: string): string {
  return JSON.stringify({
    id: "msg-v4-test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Mocked anthropic response" }],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 9, output_tokens: 4 },
  })
}

function okStreamFrames(model: string): Array<string> {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg-stream", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from mocked stream" } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    "data: [DONE]\n\n",
  ]
}

/** A thinking block with a signature_delta, then a text block — exercises the byte-critical thinking-signature forward. */
function thinkingStreamFrames(model: string): Array<string> {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg-think", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me reason" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc-123" } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    "data: [DONE]\n\n",
  ]
}

/** A stream that begins, then emits a terminal `error` SSE frame (H2). */
function errorFrameStreamFrames(model: string): Array<string> {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg-err", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } })}\n\n`,
    `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "upstream overloaded" } })}\n\n`,
  ]
}

/** A stream that enqueues a few frames then ERRORS the ReadableStream mid-flight (H3 — the for-await throws → pump's catch synthesizes an error frame). */
function midStreamThrowResponse(model: string): Response {
  const frames = okStreamFrames(model).slice(0, 3) // message_start + content_block_start + first text delta
  const enc = new TextEncoder()
  let i = 0
  // pull-based: each frame is delivered (consumer drains it) BEFORE the error,
  // so the partial content is forwarded. A synchronous enqueue-then-error in
  // start() would ResetQueue and drop the unread frames (Streams spec).
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) {
        controller.enqueue(enc.encode(frames[i++]))
        return
      }
      controller.error(new Error("upstream stream blew up"))
    },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}

/** A 400 whose body references a deferred tool by name — triggers the deferred-tool retry strategy. */
function toolReferenceError400(): Response {
  return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Tool reference 'search' not found in available tools" } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  })
}

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? JSON.parse(init.body) : {}

  if (url.endsWith("/v1/messages")) {
    messagesHits += 1
    capturedWire = payload
    if (throwOnce) {
      throwOnce = false
      throw new Error("ECONNRESET: upstream socket reset")
    }
    // deferred-tool: the FIRST hit of a run 400s with a tool-reference error;
    // the strategy undefers the tool and retries → the second hit succeeds.
    if (scenario === "deferredTool" && messagesHits === 1) {
      return Promise.resolve(toolReferenceError400())
    }
    const model = payload.model ?? "unknown"
    if (payload.stream) {
      if (scenario === "midStreamThrow") return Promise.resolve(midStreamThrowResponse(model))
      const frames =
        scenario === "thinking" ? thinkingStreamFrames(model)
        : scenario === "errorFrame" ? errorFrameStreamFrames(model)
        : okStreamFrames(model)
      return Promise.resolve(createSseResponse(frames))
    }
    return Promise.resolve(new Response(nonStreamingBody(model), { status: 200, headers: { "content-type": "application/json" } }))
  }
  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

/** Production-faithful app: installs observabilityMiddleware so a reject's c.set ctx is finalized from the 4xx status (parity with src/server.ts). */
function createObservableApp(): Hono {
  const obsApp = new Hono()
  obsApp.onError((error, c) => forwardError(c, error))
  obsApp.use(observabilityMiddleware())
  registerHttpRoutes(obsApp)
  return obsApp
}

const observableApp = createObservableApp()

function injectModels(): void {
  setModels({
    object: "list",
    data: [
      mockModel("claude-sonnet-4.6", { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] }),
      mockModel("claude-opus-4.6", { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] }),
      mockModel("gpt-4o", { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] }),
    ],
  })
  setModelOverrides({ opus: "claude-opus-4.6" })
}

async function post(body: unknown, target: Hono = app): Promise<Response> {
  injectModels()
  return target.request("/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
}

describe("Anthropic v4 ↔ legacy equivalence", () => {
  autoTestRuntime()
  autoRestoreFetch()

  beforeEach(() => {
    messagesHits = 0
    capturedWire = undefined
    throwOnce = false
    scenario = "ok"
    upstreamFetchMock.mockClear()
    setStateForTests({ copilotToken: "tok", accountType: "individual", vsCodeVersion: "1.100.0", fetchTimeout: 0 })
    applyFetchMock(upstreamFetchMock)
  })

  afterEach(async () => {
    setV4DriverEnabled("anthropic", DEFAULT_V4_FLAG)
    // The deferred-tool strategy records sticky-undeferred tools in the
    // process-global feature-negotiation ledger; reset it so it doesn't leak
    // into sibling tests (or the second sub-run within a test).
    await resetAnthropicFeatureNegotiationForTesting()
  })

  test("direct non-streaming: client json + wire payload equal", async () => {
    const body = { model: "claude-sonnet-4.6", messages: [{ role: "user", content: "Hello" }], max_tokens: 64, stream: false }

    setV4DriverEnabled("anthropic", false)
    const legacy = (await (await post(body)).json()) as Record<string, unknown>
    const legacyWire = capturedWire

    setV4DriverEnabled("anthropic", true)
    const v4 = (await (await post(body)).json()) as Record<string, unknown>
    const v4Wire = capturedWire

    expect(v4).toEqual(legacy)
    expect(v4Wire).toEqual(legacyWire)
  })

  test("direct streaming: client SSE bytes equal", async () => {
    const body = { model: "claude-sonnet-4.6", messages: [{ role: "user", content: "Stream please" }], max_tokens: 64, stream: true }

    setV4DriverEnabled("anthropic", false)
    const legacyText = await (await post(body)).text()

    setV4DriverEnabled("anthropic", true)
    const v4Text = await (await post(body)).text()

    expect(v4Text).toBe(legacyText)
    expect(v4Text).toContain("Hello from mocked stream")
    expect(v4Text).toContain("message_stop")
  })

  test("streaming thinking + signature_delta forwarded byte-for-byte (both paths equal)", async () => {
    scenario = "thinking"
    const body = { model: "claude-sonnet-4.6", messages: [{ role: "user", content: "Think" }], max_tokens: 256, stream: true }

    setV4DriverEnabled("anthropic", false)
    const legacyText = await (await post(body)).text()

    setV4DriverEnabled("anthropic", true)
    const v4Text = await (await post(body)).text()

    expect(v4Text).toBe(legacyText)
    expect(v4Text).toContain("sig-abc-123") // signature survives forwarding
    expect(v4Text).toContain("thinking_delta")
  })

  test("alias resolves + non-streaming wire model is canonical (both paths equal)", async () => {
    const body = { model: "opus", messages: [{ role: "user", content: "Hello" }], max_tokens: 64, stream: false }

    setV4DriverEnabled("anthropic", false)
    const legacy = (await (await post(body)).json()) as Record<string, unknown>
    const legacyWire = capturedWire

    setV4DriverEnabled("anthropic", true)
    const v4 = (await (await post(body)).json()) as Record<string, unknown>
    const v4Wire = capturedWire

    expect(v4).toEqual(legacy)
    expect(v4Wire?.model).toBe("claude-opus-4.6")
    expect(v4Wire).toEqual(legacyWire)
  })

  test("network-retry: a transient upstream error retries once then succeeds (both paths, 2 hits)", async () => {
    const body = { model: "claude-sonnet-4.6", messages: [{ role: "user", content: "Hello" }], max_tokens: 64, stream: false }

    setV4DriverEnabled("anthropic", false)
    throwOnce = true
    messagesHits = 0
    const legacy = (await (await post(body)).json()) as Record<string, unknown>
    expect(messagesHits).toBe(2)

    setV4DriverEnabled("anthropic", true)
    throwOnce = true
    messagesHits = 0
    const v4 = (await (await post(body)).json()) as Record<string, unknown>
    expect(messagesHits).toBe(2)
    expect(v4).toEqual(legacy)
  })

  test("history: non-streaming success finalizes the entry (completed) on both paths", async () => {
    const body = { model: "claude-sonnet-4.6", messages: [{ role: "user", content: "Hello" }], max_tokens: 64, stream: false }

    setV4DriverEnabled("anthropic", false)
    await post(body)
    const legacyState = getHistory({ endpoint: "anthropic-messages" }).entries[0]?.state

    setV4DriverEnabled("anthropic", true)
    await post(body)
    const v4State = getHistory({ endpoint: "anthropic-messages" }).entries[0]?.state

    expect(legacyState).toBe("completed")
    expect(v4State).toBe("completed")
  })

  test("history double-track (L2): effective + outbound both anthropic-messages, equal to legacy", async () => {
    const body = { model: "claude-sonnet-4.6", messages: [{ role: "user", content: "Hello" }], max_tokens: 64, stream: false }

    setV4DriverEnabled("anthropic", false)
    await post(body)
    const legacy = getHistory({ endpoint: "anthropic-messages" }).entries[0]

    setV4DriverEnabled("anthropic", true)
    await post(body)
    const v4 = getHistory({ endpoint: "anthropic-messages" }).entries[0]

    expect(v4?.effectiveRequest?.format).toBe(legacy?.effectiveRequest?.format)
    expect(v4?.effectiveRequest?.format).toBe("anthropic-messages")
    expect(v4?.effectiveRequest?.model).toBe(legacy?.effectiveRequest?.model)
    expect(v4?.outboundRequest?.format).toBe(legacy?.outboundRequest?.format)
    expect(v4?.outboundRequest?.format).toBe("anthropic-messages")
    expect(v4?.outboundRequest?.messageCount).toBe(legacy?.outboundRequest?.messageCount)
    expect(typeof v4?.queueWaitMs).toBe("number")
  })

  test("history records raw sseEvents (upstream) + forwarded sseEvents (inboundResponse) on the v4 streaming path", async () => {
    const body = { model: "claude-sonnet-4.6", messages: [{ role: "user", content: "Stream" }], max_tokens: 64, stream: true }

    // The raw upstream frames land in `sseEvents`; the client-facing forwarded
    // frames land in `inboundResponse.sseEvents` (request.ts maps the internal
    // `_forwardedResponse` → entry.inboundResponse). Both tracks must be present.
    setV4DriverEnabled("anthropic", true)
    await (await post(body)).text()
    const entry = getHistory({ endpoint: "anthropic-messages" }).entries[0]

    expect(Array.isArray(entry?.sseEvents)).toBe(true)
    expect(entry?.sseEvents?.length ?? 0).toBeGreaterThan(0)
    expect(Array.isArray(entry?.inboundResponse?.sseEvents)).toBe(true)
    expect(entry?.inboundResponse?.sseEvents?.length ?? 0).toBeGreaterThan(0)
  })

  test("reject (non-Anthropic vendor) → 400 on both paths, no upstream hit", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "Hello" }], max_tokens: 32, stream: false }

    setV4DriverEnabled("anthropic", false)
    messagesHits = 0
    expect((await post(body)).status).toBe(400)
    expect(messagesHits).toBe(0)

    setV4DriverEnabled("anthropic", true)
    messagesHits = 0
    expect((await post(body)).status).toBe(400)
    expect(messagesHits).toBe(0)
  })

  test("reject → history finalized as failed (production-faithful app with observabilityMiddleware)", async () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "Hello" }], max_tokens: 32, stream: false }

    // The v4 codec.parse creates the ctx unconditionally, then decideRoute rejects
    // — under the middleware, that c.set ctx is finalized from the 400 status to
    // `failed` (RFC §11.5 — not a dangling/pending entry).
    setV4DriverEnabled("anthropic", true)
    const res = await post(body, observableApp)
    expect(res.status).toBe(400)

    const entry = getHistory({ endpoint: "anthropic-messages" }).entries[0]
    expect(entry?.state).toBe("failed")
  })

  test("H2: terminal upstream `error` SSE frame → forwarded once → ctx.fail (both paths equal)", async () => {
    scenario = "errorFrame"
    const body = { model: "claude-sonnet-4.6", messages: [{ role: "user", content: "Hello" }], max_tokens: 64, stream: true }

    setV4DriverEnabled("anthropic", false)
    const legacyRes = await post(body, observableApp)
    const legacyText = await legacyRes.text()
    const legacyState = getHistory({ endpoint: "anthropic-messages" }).entries[0]?.state

    setV4DriverEnabled("anthropic", true)
    const v4Res = await post(body, observableApp)
    const v4Text = await v4Res.text()
    const v4State = getHistory({ endpoint: "anthropic-messages" }).entries[0]?.state

    // SSE already started → 200, not a thrown 500.
    expect(v4Res.status).toBe(200)
    expect(v4Text).toBe(legacyText)
    // The error frame is forwarded EXACTLY once (not dropped, not duplicated).
    expect(v4Text.match(/"type":"error"/g)?.length).toBe(1)
    // Terminal error settles the ctx as failed (not a thrown error → 500).
    expect(v4State).toBe("failed")
    expect(legacyState).toBe("failed")
  })

  test("H3: a mid-stream ReadableStream error → pump synthesizes an error frame → ctx.fail (both paths equal)", async () => {
    scenario = "midStreamThrow"
    const body = { model: "claude-sonnet-4.6", messages: [{ role: "user", content: "Hello" }], max_tokens: 64, stream: true }

    setV4DriverEnabled("anthropic", false)
    const legacyText = await (await post(body, observableApp)).text()
    const legacyState = getHistory({ endpoint: "anthropic-messages" }).entries[0]?.state

    setV4DriverEnabled("anthropic", true)
    const v4Text = await (await post(body, observableApp)).text()
    const v4State = getHistory({ endpoint: "anthropic-messages" }).entries[0]?.state

    expect(v4Text).toBe(legacyText)
    // The partial content forwarded before the throw is preserved, then a
    // synthesized error frame is appended (catch path).
    expect(v4Text).toContain("Hello from mocked stream")
    expect(v4Text).toContain('"type":"error"')
    expect(v4State).toBe("failed")
    expect(legacyState).toBe("failed")
  })

  test("deferred-tool retry: a tool-reference 400 undefers the tool + retries (both paths, 2 hits, undeferred on the wire)", async () => {
    scenario = "deferredTool"
    const body = {
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 64,
      stream: false,
      tools: [{ name: "search", description: "search the web", input_schema: { type: "object", properties: {} }, defer_loading: true }],
    }

    setV4DriverEnabled("anthropic", false)
    await resetAnthropicFeatureNegotiationForTesting()
    messagesHits = 0
    const legacy = (await (await post(body)).json()) as Record<string, unknown>
    expect(messagesHits).toBe(2)
    const legacyRetryTool = capturedWire?.tools?.find((t) => t.name === "search") as { defer_loading?: boolean } | undefined

    setV4DriverEnabled("anthropic", true)
    await resetAnthropicFeatureNegotiationForTesting()
    messagesHits = 0
    const v4 = (await (await post(body)).json()) as Record<string, unknown>
    expect(messagesHits).toBe(2)
    const v4RetryTool = capturedWire?.tools?.find((t) => t.name === "search") as { defer_loading?: boolean } | undefined

    // The retry's outbound wire (post-retry env) carries the UNdeferred tool.
    expect(legacyRetryTool?.defer_loading).toBeFalsy()
    expect(v4RetryTool?.defer_loading).toBeFalsy()
    expect(v4).toEqual(legacy)
  })
})
