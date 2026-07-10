/**
 * Responses buffered-retry adoption (Task 3.2) — http end-to-end.
 *
 * With `responsesBufferedRetry` ENABLED, the Responses `/responses` streaming pump selects
 * `driver.runResponseBufferedSink`: it buffers the whole rendered generation and, when the
 * upstream RSTs mid-stream (transport-close), discards the buffer + re-exchanges, transparently
 * delivering ONE complete generation to the client (mirroring the Anthropic L2 path). Asserts:
 *   1. buffered ON: attempt 1 truncates mid-stream, attempt 2 completes → the client receives
 *      the COMPLETE second generation exactly once (no attempt-1 partial), history `completed`,
 *      upstream exchanged > 1 time, hit-rate telemetry counts the save-after-retry.
 *   2. live OFF (default): a mid-stream drop (clean-EOF truncation, no terminal) → `failed`,
 *      the partial IS preserved (live-forwarded) + a Responses error frame terminates the
 *      client stream (handler-v4.ts truncation gate, unchanged).
 *
 * The default-OFF live behavior is otherwise locked by responses-stream-truncation.http.test.ts.
 * Harness shape mirrors tests/anthropic/streaming-l2-buffered.http.test.ts (call-count-driven
 * fetch mock + createSseResponseThenError for a deterministic mid-stream RST).
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getProtectStreamingStats } from "~/lib/anthropic/protect-streaming-stats"
import { getHistory } from "~/lib/history/store"
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
  createSseResponseThenError,
  frameTypesInOrder,
} from "../helpers/sse"

const MODEL = "gpt-5"

/** A complete direct-Responses generation: created + a distinctive text delta + response.completed. */
function completeFrames(model: string): Array<string> {
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "resp_up_2", object: "response", status: "in_progress", model, output: [] } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 1, item_id: "msg_1", output_index: 0, content_index: 0, delta: "COMPLETE_ATTEMPT_2" })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 2, response: { id: "resp_up_2", object: "response", status: "completed", model, output: [], usage: { input_tokens: 100, output_tokens: 20 } } })}\n\n`,
  ]
}

/** A partial generation (created + a distinctive text delta), then the upstream body ERRORS (RST). */
function partialFrames(model: string): Array<string> {
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "resp_up_1", object: "response", status: "in_progress", model, output: [] } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 1, item_id: "msg_0", output_index: 0, content_index: 0, delta: "PARTIAL_ATTEMPT_1" })}\n\n`,
  ]
}

/** The real upstream error code/message (a terminal server_error decision — Responses' H2). */
const UPSTREAM_ERROR_CODE = "server_error"
const UPSTREAM_ERROR_MESSAGE = "The model is overloaded. Please try again later."

/**
 * A generation that drains CLEANLY (no transport cut) but the upstream's terminal frame is an
 * in-band `type: "error"` event (overload / server_error) instead of `response.completed` — the
 * Responses analog of Anthropic's H2. It sets NO `acc.status` (only response.completed/.failed/
 * .incomplete do), so the handler must fail via `acc.streamError`, NOT the truncation gate.
 */
function terminalErrorFrames(model: string): Array<string> {
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "resp_up_err", object: "response", status: "in_progress", model, output: [] } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 1, item_id: "msg_e", output_index: 0, content_index: 0, delta: "PARTIAL_BEFORE_ERROR" })}\n\n`,
    `event: error\ndata: ${JSON.stringify({ type: "error", sequence_number: 2, message: UPSTREAM_ERROR_MESSAGE, code: UPSTREAM_ERROR_CODE })}\n\n`,
  ]
}

const RST_ERROR = new Error("Stream closed with error code NGHTTP2_CANCEL")

/** Number of leading upstream attempts that RST before the upstream finally completes. */
let rstBeforeComplete = 0
/** When true, EVERY attempt cleanly drains WITHOUT a terminal (live truncation scenario). */
let truncateClean = false
/** When true, the upstream drains cleanly but ends with a terminal in-band `error` frame (H2). */
let terminalError = false
let upstreamCalls = 0

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
  const model = payload.model ?? MODEL
  if (url.endsWith("/responses")) {
    upstreamCalls += 1
    if (terminalError) return Promise.resolve(createSseResponse(terminalErrorFrames(model))) // clean drain, terminal error frame
    if (truncateClean) return Promise.resolve(createSseResponse(partialFrames(model))) // clean EOF, no terminal
    const rst = upstreamCalls <= rstBeforeComplete
    return Promise.resolve(rst ? createSseResponseThenError(partialFrames(model), RST_ERROR) : createSseResponse(completeFrames(model)))
  }
  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

async function streamRequest(): Promise<Response> {
  setDisabledModels([])
  setModels({ object: "list", data: [mockModel(MODEL, { vendor: "OpenAI", supported_endpoints: ["/responses"] })] })
  return app.request("/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: "hi", stream: true }),
  })
}

describe("Responses buffered-retry adoption (Task 3.2)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    upstreamCalls = 0
    rstBeforeComplete = 0
    truncateClean = false
    terminalError = false
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      upstreamWebSocket: false,
    })
    applyFetchMock(upstreamFetchMock)
  })

  test("buffered mode retries a mid-stream upstream drop and delivers ONE complete generation", async () => {
    setStateForTests({ responsesBufferedRetry: true, protectStreamingMaxRetries: 2, streamKeepalivePingSec: 20 })
    rstBeforeComplete = 1 // attempt 1 RSTs mid-stream, attempt 2 (retry) completes

    const sse = await (await streamRequest()).text()

    // The client sees ONLY the final complete generation — the attempt-1 partial never leaks.
    expect(sse).not.toContain("PARTIAL_ATTEMPT_1")
    expect(sse).toContain("COMPLETE_ATTEMPT_2")
    expect(frameTypesInOrder(sse)).toContain("response.completed")
    // The Responses error frame is `event: error\ndata: {"error":{...}}` (no top-level `type`) — a
    // clean success must carry neither the error frame nor the truncation terminator.
    expect(sse).not.toContain("event: error")
    expect(sse).not.toContain("truncated")

    // 2 upstream exchanges (1 RST + 1 complete).
    expect(upstreamCalls).toBe(2)

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    expect(entry?.attempts?.at(-1)?.upstreamResponse?.success).toBe(true)
    // Per-attempt isolation (onAttemptReset): the committed generation's derived content is ONLY
    // attempt 2's — the discarded attempt-1 partial must NOT leak into the history record. Without
    // the fresh-accumulator reset, `contentParts` would append across attempts and this would carry
    // "PARTIAL_ATTEMPT_1COMPLETE_ATTEMPT_2".
    const committedBody = JSON.stringify(entry?.attempts?.at(-1)?.upstreamResponse?.body)
    expect(committedBody).toContain("COMPLETE_ATTEMPT_2")
    expect(committedBody).not.toContain("PARTIAL_ATTEMPT_1")
    // Hit-rate telemetry parity with Anthropic: one save after 1 retry.
    expect(getProtectStreamingStats()).toEqual({ success: 1, exhausted: 0, retreated: 0, totalRetries: 1 })
  })

  test("buffered mode: a clean first-try commit is NOT counted as a retry", async () => {
    setStateForTests({ responsesBufferedRetry: true, protectStreamingMaxRetries: 2, streamKeepalivePingSec: 20 })
    rstBeforeComplete = 0 // upstream completes first try — the buffered happy path, zero retries

    const sse = await (await streamRequest()).text()
    expect(frameTypesInOrder(sse)).toContain("response.completed")
    expect(upstreamCalls).toBe(1)

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    // L2 never ENGAGED (no RST) → no telemetry (would otherwise inflate the hit-rate).
    expect(getProtectStreamingStats()).toEqual({ success: 0, exhausted: 0, retreated: 0, totalRetries: 0 })
  })

  test("live mode (default) fails a mid-stream drop and preserves the partial", async () => {
    setStateForTests({ responsesBufferedRetry: false })
    truncateClean = true // a clean-EOF mid-stream drop (no terminal) — the live truncation gate fires

    const sse = await (await streamRequest()).text()

    // Live forwards frames as they arrive — the partial IS on the wire…
    expect(sse).toContain("PARTIAL_ATTEMPT_1")
    // …terminated by a Responses error frame (the truncation terminator, `event: error`).
    expect(sse).toContain("event: error")
    expect(sse).toContain("truncated")
    // No retry: live never re-exchanges.
    expect(upstreamCalls).toBe(1)

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("failed")
    expect(entry?.attempts?.at(-1)?.upstreamResponse?.success).toBe(false)
    expect(String(entry?._index?.derived?.failureReason)).toContain("truncated")
  })

  // ── Terminal upstream `error` frame (H2) — the real error must surface, NOT "truncated" ──
  // A clean-draining stream whose terminal frame is an in-band `type:"error"` (overload/server_error)
  // is an upstream DECISION to fail, delivered as a real content frame the client already received.
  // The handler must fail via `acc.streamError` (the REAL code/message), NOT synthesize a SECOND
  // "truncated" error frame (double-terminate) NOR mislabel the cause as "truncated". Locks both modes.

  test("live mode: a terminal upstream error frame surfaces the real error exactly once (not 'truncated')", async () => {
    setStateForTests({ responsesBufferedRetry: false })
    terminalError = true

    const sse = await (await streamRequest()).text()

    // The REAL upstream error frame reached the client (forwarded live, verbatim).
    expect(sse).toContain(UPSTREAM_ERROR_MESSAGE)
    expect(sse).toContain(UPSTREAM_ERROR_CODE)
    // …exactly ONCE — no second synthetic "truncated" error frame double-terminating the stream.
    expect(sse.split("event: error").length - 1).toBe(1)
    expect(sse).not.toContain("truncated")
    // No retry on live.
    expect(upstreamCalls).toBe(1)

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("failed")
    expect(entry?.attempts?.at(-1)?.upstreamResponse?.success).toBe(false)
    // The recorded failure reason is the REAL upstream cause, NOT "truncated".
    const reason = String(entry?._index?.derived?.failureReason)
    expect(reason).toContain(UPSTREAM_ERROR_CODE)
    expect(reason).toContain(UPSTREAM_ERROR_MESSAGE)
    expect(reason).not.toContain("truncated")
  })

  test("buffered mode: a terminal upstream error frame commits + surfaces the real error once (not 'truncated', no retry)", async () => {
    setStateForTests({ responsesBufferedRetry: true, protectStreamingMaxRetries: 2, streamKeepalivePingSec: 20 })
    terminalError = true

    const sse = await (await streamRequest()).text()

    // The buffered sink COMMITS the terminal error frame (driver.ts:661 sawUpstreamError) → the client
    // receives the REAL error, exactly once, and the handler fails via acc.streamError (no retry).
    expect(sse).toContain(UPSTREAM_ERROR_MESSAGE)
    expect(sse).toContain(UPSTREAM_ERROR_CODE)
    expect(sse.split("event: error").length - 1).toBe(1)
    expect(sse).not.toContain("truncated")
    // An upstream `error` is a terminal DECISION — the buffered path commits it, it is NOT retried.
    expect(upstreamCalls).toBe(1)

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("failed")
    expect(entry?.attempts?.at(-1)?.upstreamResponse?.success).toBe(false)
    const reason = String(entry?._index?.derived?.failureReason)
    expect(reason).toContain(UPSTREAM_ERROR_CODE)
    expect(reason).toContain(UPSTREAM_ERROR_MESSAGE)
    expect(reason).not.toContain("truncated")
  })
})
