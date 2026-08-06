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
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import { getProtectStreamingStats } from "~/lib/anthropic/protect-streaming-stats"
import { getHistory } from "~/lib/history/store"
import { setModels } from "~/lib/models/cache"
import {
  //
  setDisabledModels,
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

/** A two-output-item direct generation: created → item0(done) → item1(done) → completed. */
function twoItemFrames(model: string): Array<string> {
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "resp_2i", object: "response", status: "in_progress", model, output: [] } })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { id: "msg_0", type: "message", role: "assistant", content: [] } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 2, output_index: 0, content_index: 0, delta: "BLOCK_ZERO" })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", sequence_number: 3, output_index: 0, item: { id: "msg_0", type: "message", role: "assistant", content: [{ type: "output_text", text: "BLOCK_ZERO" }] } })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", sequence_number: 4, output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [] } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 5, output_index: 1, content_index: 0, delta: "BLOCK_ONE" })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", sequence_number: 6, output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "BLOCK_ONE" }] } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 7, response: { id: "resp_2i", object: "response", status: "completed", model, output: [], usage: { input_tokens: 50, output_tokens: 8 } } })}\n\n`,
  ]
}

/**
 * The FIRST output item commits (`output_item.done`), then the upstream RSTs before the SECOND item
 * ever starts — no `response.completed`, so `acc.status` never sets. Without `commitBoundaries`
 * wired, the driver cannot see the item0 boundary: `committedAny` never flips, so this looks like an
 * ordinary pre-commit truncation and gets RETRIED (up to cap → `exhausted`). WITH `commitBoundaries`
 * wired, item0's `output_item.done` flushes it live and closes the retry window — the RST after it is
 * un-retryable (the committed prefix is already on the wire) → `partial-degrade`, NOT retried.
 */
function firstBlockCommittedThenRstFrames(model: string): Array<string> {
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "resp_deg", object: "response", status: "in_progress", model, output: [] } })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { id: "msg_0", type: "message", role: "assistant", content: [] } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 2, output_index: 0, content_index: 0, delta: "BLOCK_ZERO" })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", sequence_number: 3, output_index: 0, item: { id: "msg_0", type: "message", role: "assistant", content: [{ type: "output_text", text: "BLOCK_ZERO" }] } })}\n\n`,
  ]
}

/**
 * Truncates BEFORE the first output item ever commits (no `output_item.done` yet) — a pure
 * pre-commit RST. Distinct delta text (`BLOCK_ZERO_ATTEMPT1`) from the retry attempt's
 * {@link twoItemFrames} (`BLOCK_ZERO`) so a leaked attempt-1 partial is unambiguously detectable.
 */
function preFirstItemTruncateFrames(model: string): Array<string> {
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "resp_pre", object: "response", status: "in_progress", model, output: [] } })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { id: "msg_0", type: "message", role: "assistant", content: [] } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 2, output_index: 0, content_index: 0, delta: "BLOCK_ZERO_ATTEMPT1" })}\n\n`,
  ]
}

/**
 * item0 commits (`output_item.done`), item1 starts and gets a partial delta (no `done` for item1),
 * then the upstream RSTs — the committed first block must reach the client, the un-committed second
 * block must NOT.
 */
function postFirstItemTruncateFrames(model: string): Array<string> {
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "resp_post", object: "response", status: "in_progress", model, output: [] } })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { id: "msg_0", type: "message", role: "assistant", content: [] } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 2, output_index: 0, content_index: 0, delta: "BLOCK_ZERO" })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", sequence_number: 3, output_index: 0, item: { id: "msg_0", type: "message", role: "assistant", content: [{ type: "output_text", text: "BLOCK_ZERO" }] } })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", sequence_number: 4, output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [] } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 5, output_index: 1, content_index: 0, delta: "BLOCK_ONE" })}\n\n`,
  ]
}

/** A clean one-shot CC (`/chat/completions`) SSE stream — mirrors chat-completions-via-responses.http.test.ts. */
function ccStreamFrames(model: string): Array<string> {
  return [
    `data: ${JSON.stringify({
      id: "chatcmpl-fallback",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: { content: "FALLBACK_REPLY" }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-fallback",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`,
    "data: [DONE]\n\n",
  ]
}

/** When true, the upstream mock is CC-shaped and answers `/chat/completions` instead of `/responses`. */
let viaFallbackUpstream = false

const RST_ERROR = new Error("Stream closed with error code NGHTTP2_CANCEL")

/** Number of leading upstream attempts that RST before the upstream finally completes. */
let rstBeforeComplete = 0
/** When true, EVERY attempt cleanly drains WITHOUT a terminal (live truncation scenario). */
let truncateClean = false
/** When true, the upstream drains cleanly but ends with a terminal in-band `error` frame (H2). */
let terminalError = false
/** When true, the upstream returns the two-output-item fixture ({@link twoItemFrames}). */
let twoItem = false
/**
 * When true, the FIRST attempt commits item0 (`output_item.done`) then RSTs before item1/completed;
 * every subsequent attempt (if the driver wrongly retries) does the same, so a retry never reaches a
 * terminal — a wrong "retry every truncation" implementation would exhaust to `failed`/`exhausted`
 * instead of the correct un-retryable `partial-degrade` after exactly ONE upstream exchange.
 */
let firstBlockThenRst = false
/**
 * When true: attempt 1 RSTs BEFORE the first `output_item.done` (no block committed) → the driver's
 * `!committedAny` gate retries; attempt 2 (and beyond) delivers the full {@link twoItemFrames}.
 */
let preFirstItemTruncateThenComplete = false
/**
 * When true: the FIRST attempt commits item0 (`output_item.done`) live, then flushes item1's partial
 * delta (no `output_item.done` for item1) before RSTing — the un-committed SECOND block must not
 * reach the client, but the committed first block must.
 */
let postFirstItemTruncate = false
let upstreamCalls = 0

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
  const model = payload.model ?? MODEL
  if (url.endsWith("/chat/completions")) {
    upstreamCalls += 1
    return Promise.resolve(createSseResponse(ccStreamFrames(model)))
  }
  if (url.endsWith("/responses")) {
    upstreamCalls += 1
    if (terminalError) return Promise.resolve(createSseResponse(terminalErrorFrames(model))) // clean drain, terminal error frame
    if (truncateClean) return Promise.resolve(createSseResponse(partialFrames(model))) // clean EOF, no terminal
    if (twoItem) return Promise.resolve(createSseResponse(twoItemFrames(model))) // multi-item block-level fixture
    if (firstBlockThenRst) return Promise.resolve(createSseResponseThenError(firstBlockCommittedThenRstFrames(model), RST_ERROR)) // item0 committed, then RST
    if (postFirstItemTruncate) return Promise.resolve(createSseResponseThenError(postFirstItemTruncateFrames(model), RST_ERROR)) // item0 committed, item1 partial, then RST
    if (preFirstItemTruncateThenComplete) {
      // attempt 1: pre-commit RST (no output_item.done yet); attempt 2+: full two-item generation.
      return Promise.resolve(
        upstreamCalls === 1 ? createSseResponseThenError(preFirstItemTruncateFrames(model), RST_ERROR) : createSseResponse(twoItemFrames(model)),
      )
    }
    const rst = upstreamCalls <= rstBeforeComplete
    return Promise.resolve(rst ? createSseResponseThenError(partialFrames(model), RST_ERROR) : createSseResponse(completeFrames(model)))
  }
  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

async function streamRequest(): Promise<Response> {
  setDisabledModels([])
  setModels({
    object: "list",
    data: [
      mockModel(MODEL, {
        vendor: "OpenAI",
        supported_endpoints: viaFallbackUpstream ? ["/chat/completions"] : ["/responses"],
      }),
    ],
  })
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
    twoItem = false
    firstBlockThenRst = false
    preFirstItemTruncateThenComplete = false
    postFirstItemTruncate = false
    viaFallbackUpstream = false
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
    setStateForTests({
      responsesBufferedRetry: true,
      bufferedRetryShared: { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 },
      streamKeepalivePingSec: 20,
    })
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
    // Hit-rate telemetry parity with Anthropic: one save after 1 retry, under the `responses` vendor.
    expect(getProtectStreamingStats().responses).toEqual({
      success: 1,
      exhausted: 0,
      retreated: 0,
      partialDegrade: 0,
      totalRetries: 1,
      retriesBeforeDegrade: 0,
      continuationExhausted: 0,
      precontentRecoverySuccess: 0,
      precontentRecoveryExhausted: 0,
      preFirstBlockRetries: 1,
      continuationRetries: 0,
    })
  })

  test("buffered mode EXHAUSTION: every attempt truncates up to retryCap → settle FAIL, last partial preserved, exhausted outcome", async () => {
    // retryCap = resolveBufferedCaps("responses").maxRetries (2) → 1 original + 2 re-exchanges = 3 attempts, all RST.
    setStateForTests({
      responsesBufferedRetry: true,
      bufferedRetryShared: { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 },
      streamKeepalivePingSec: 20,
    })
    rstBeforeComplete = 99 // EVERY attempt RSTs mid-stream — the upstream never reaches a terminal

    // The buffered pump must ALSO emit the [upstream-diagnostics] disconnect line on the exhausted
    // stream-error, carrying the LAST attempt's REAL signals via the rebound collector (LOW-2 wiring
    // guard): frames>0 (partialFrames has 2), never `frames=0`, honest last-frame — NOT the pre-fix
    // silence. Locks that the buffered `onAttemptReset` rebind actually feeds `logUpstreamStreamError`.
    const diagSpy = spyOn(consola, "error").mockImplementation(Object.assign(() => {}, { raw: () => {} }))
    let sse: string
    try {
      sse = await (await streamRequest()).text()
    } finally {
      const diagLine = diagSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("[upstream-diagnostics] STREAM DISCONNECT"))
      diagSpy.mockRestore()
      expect(diagLine).toBeDefined()
      expect(diagLine).toContain("model=gpt-5")
      expect(diagLine).not.toContain("frames=0")
      expect(diagLine).not.toContain("last-frame=none@0ms")
    }

    // All-or-nothing: nothing committed → the client gets ZERO content frames, only the synthetic
    // error terminator (the buffered path never live-forwards a discarded attempt's partial).
    expect(sse).not.toContain("PARTIAL_ATTEMPT_1")
    expect(sse).not.toContain("COMPLETE_ATTEMPT_2")
    expect(frameTypesInOrder(sse)).not.toContain("response.completed")
    expect(sse).toContain("event: error")

    // attempts == retryCap + 1 (3 upstream exchanges: original + 2 retries, all RST).
    expect(upstreamCalls).toBe(3)

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    // settle FAIL — retries exhausted, surfaced as a stream error.
    expect(entry?.state).toBe("failed")
    expect(entry?.attempts?.at(-1)?.upstreamResponse?.success).toBe(false)
    expect(entry?._index?.derived?.attemptCount).toBe(3)
    // The LAST attempt's partial is preserved in its history record (the final failed attempt keeps
    // its upstream-original frames at the top-level slot — D1 — so a diagnosis is never lost).
    expect(JSON.stringify(entry?.attempts?.at(-1))).toContain("PARTIAL_ATTEMPT_1")
    // onBufferedResolve("exhausted", 2): the L2 engagement is recorded as an exhaustion, NOT a save.
    expect(getProtectStreamingStats().responses).toEqual({
      success: 0,
      exhausted: 1,
      retreated: 0,
      partialDegrade: 0,
      totalRetries: 2,
      retriesBeforeDegrade: 0,
      continuationExhausted: 0,
      precontentRecoverySuccess: 0,
      precontentRecoveryExhausted: 0,
      preFirstBlockRetries: 2,
      continuationRetries: 0,
    })
  })

  test("buffered mode: a clean first-try commit is NOT counted as a retry", async () => {
    setStateForTests({
      responsesBufferedRetry: true,
      bufferedRetryShared: { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 },
      streamKeepalivePingSec: 20,
    })
    rstBeforeComplete = 0 // upstream completes first try — the buffered happy path, zero retries

    const sse = await (await streamRequest()).text()
    expect(frameTypesInOrder(sse)).toContain("response.completed")
    expect(upstreamCalls).toBe(1)

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    // L2 never ENGAGED (no RST) → no telemetry (would otherwise inflate the hit-rate). No vendor bucket.
    expect(getProtectStreamingStats()).toEqual({})
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
    setStateForTests({
      responsesBufferedRetry: true,
      bufferedRetryShared: { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 },
      streamKeepalivePingSec: 20,
    })
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

  // ── Block-level commit boundaries (P2 Task 2) ──
  // The buffered branch wires `commitBoundaries: isResponsesCommitBoundary` — each
  // `response.output_item.done` becomes an in-loop flush boundary instead of the terminal-only
  // whole-response commit. See the file-header note (Task 2 brief) for why an it-level test cannot
  // assert flush TIMING directly (the HTTP harness only observes the converged full stream) — this
  // locks the multi-item ORDERING + clean-commit invariants as a regression guard.

  test("buffered block-level: each output item flushes at its output_item.done boundary (incremental), telemetry carries the responses vendor", async () => {
    setStateForTests({
      responsesBufferedRetry: true,
      bufferedRetryShared: { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 },
      streamKeepalivePingSec: 20,
    })
    twoItem = true

    const sse = await (await streamRequest()).text()

    // Both items reached the client, in order, and the terminal completed once.
    expect(sse).toContain("BLOCK_ZERO")
    expect(sse).toContain("BLOCK_ONE")
    expect(sse.indexOf("BLOCK_ZERO")).toBeLessThan(sse.indexOf("BLOCK_ONE"))
    expect(frameTypesInOrder(sse)).toContain("response.completed")
    // Clean first-try commit → NOT counted (silent happy path); no error/truncation terminator.
    expect(sse).not.toContain("event: error")
    expect(sse).not.toContain("truncated")
    expect(upstreamCalls).toBe(1)

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    // A clean first-try commit (retries === 0) is the silent happy path — no telemetry bucket, even
    // though `commitBoundaries` fired twice in-loop (committedAny is per-generation bookkeeping, not
    // per-block telemetry).
    expect(getProtectStreamingStats()).toEqual({})
  })

  test("buffered block-level: a boundary block committed live, then RST → un-retryable partial-degrade (NOT retried, NOT exhausted)", async () => {
    setStateForTests({
      responsesBufferedRetry: true,
      bufferedRetryShared: { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 },
      streamKeepalivePingSec: 20,
    })
    firstBlockThenRst = true

    const sse = await (await streamRequest()).text()

    // item0 committed live BEFORE the RST — its content reached the client (un-retryable prefix).
    expect(sse).toContain("BLOCK_ZERO")
    // No retry: the commit boundary closed the retry window on the FIRST exchange.
    expect(upstreamCalls).toBe(1)
    // A stream-error terminator surfaces the RST (partial-degrade is still a failed generation from
    // the client's perspective — the tail never arrived).
    expect(sse).toContain("event: error")

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("failed")
    expect(entry?._index?.derived?.attemptCount).toBe(1)
    // onBufferedResolve("partial-degrade", 0, { vendor: "responses" }): a graceful degrade, distinct
    // from `exhausted` (which commits nothing) — recorded even at retries === 0 (M-1, spec §9.2).
    expect(getProtectStreamingStats().responses).toEqual({
      success: 0,
      exhausted: 0,
      retreated: 0,
      partialDegrade: 1,
      totalRetries: 0,
      retriesBeforeDegrade: 0,
      continuationExhausted: 0,
      precontentRecoverySuccess: 0,
      precontentRecoveryExhausted: 0,
      preFirstBlockRetries: 0,
      continuationRetries: 0,
    })
  })

  // ── via-chat-completions fallback sub-path (P2 Task 3) ──
  // The fallback (model without /responses support → CC upstream + CC→Responses translator)
  // synthesizes its terminal lifecycle (output_item.done → response.completed) in
  // codec.flushResponse POST-loop, invisible to the driver's in-loop block-commit AND to
  // sawMessageStop. Buffered must therefore stay LIVE for this sub-path — the gate is
  // `buffered && !viaFallback` in pumpStreamingV4 (handler-v4.ts).

  test("buffered ON does NOT engage for the via-chat-completions fallback (structural: flushResponse post-loop) — stays live, no spurious retry", async () => {
    setStateForTests({
      responsesBufferedRetry: true,
      bufferedRetryShared: { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 },
      streamKeepalivePingSec: 20,
    })
    // Model routed via CC fallback (no /responses support) → the CC→Responses translator synthesizes
    // output_item.done/response.completed POST-loop (codec.flushResponse), invisible to the in-loop
    // block commit. Buffered must therefore stay LIVE for this sub-path (else every clean fallback
    // drain is mis-retried as a truncation → exhausted).
    viaFallbackUpstream = true

    const sse = await (await streamRequest()).text()

    expect(frameTypesInOrder(sse)).toContain("response.completed")
    expect(sse).not.toContain("truncated")
    expect(upstreamCalls).toBe(1) // NOT retried

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    // The fallback path never engages `runResponseBufferedSink` (live sink instead) — `onBufferedResolve`
    // is never invoked, so no vendor bucket is ever created (not a zero-filled `{responses: {...}}`, the
    // top-level map itself stays empty — verified empirically against the real getProtectStreamingStats()).
    expect(getProtectStreamingStats()).toEqual({})
  })

  // ── Golden fixtures: block-level truncation terminals (Task 4) ──
  // Locks the two terminals implied by the block-level commit mechanism (P0 driver + P2 handler
  // wiring): a truncation BEFORE the first block ever commits is a plain pre-commit RST (retried,
  // like the whole-response path); a truncation AFTER the first block commits is un-retryable
  // (partial-degrade) because the committed prefix is already on the wire.

  test("golden: truncation BEFORE the first output_item.done retries and delivers one complete generation", async () => {
    setStateForTests({
      responsesBufferedRetry: true,
      bufferedRetryShared: { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 },
      streamKeepalivePingSec: 20,
    })
    // attempt 1: created + item0 partial text, then RST *before* output_item.done (no block committed).
    // attempt 2: full twoItemFrames.
    preFirstItemTruncateThenComplete = true

    const sse = await (await streamRequest()).text()

    expect(sse).not.toContain("BLOCK_ZERO_ATTEMPT1") // attempt-1 partial never leaked (no block committed)
    expect(sse).toContain("BLOCK_ZERO")
    expect(sse).toContain("BLOCK_ONE")
    expect(frameTypesInOrder(sse)).toContain("response.completed")
    expect(sse).not.toContain("truncated")
    expect(upstreamCalls).toBe(2) // retried once

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    // Saved after 1 retry (pre-commit truncation is retryable).
    expect(getProtectStreamingStats().responses).toEqual({
      success: 1,
      exhausted: 0,
      retreated: 0,
      partialDegrade: 0,
      totalRetries: 1,
      retriesBeforeDegrade: 0,
      continuationExhausted: 0,
      precontentRecoverySuccess: 0,
      precontentRecoveryExhausted: 0,
      preFirstBlockRetries: 1,
      continuationRetries: 0,
    })
  })

  test("golden: truncation AFTER the first output_item.done commits → partial-degrade, NOT retried, first block stays on the wire", async () => {
    setStateForTests({
      responsesBufferedRetry: true,
      bufferedRetryShared: { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 },
      streamKeepalivePingSec: 20,
    })
    // attempt 1: created + item0(done) committed, then item1 partial + RST → first block already flushed.
    postFirstItemTruncate = true

    const sse = await (await streamRequest()).text()

    // The committed first block IS on the wire (block-level flushed it at its output_item.done)…
    expect(sse).toContain("BLOCK_ZERO")
    // …the second (uncommitted) block is NOT delivered, and a Responses error frame terminates.
    expect(sse).not.toContain("BLOCK_ONE")
    expect(sse).toContain("event: error")
    // No retry: a block was already committed to the client (can't unsend) → partial-degrade.
    expect(upstreamCalls).toBe(1)

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("failed") // stream-error terminal (spec §9.3)
    expect(entry?.attempts?.at(-1)?.upstreamResponse?.success).toBe(false)
    // History clientResponse.sseEvents holds the committed block + the failure tail (richest-data-flow).
    const forwarded = JSON.stringify(entry?.attempts?.at(-1))
    expect(forwarded).toContain("BLOCK_ZERO")
    // outcome = partial-degrade (a block committed then the tail truncated), recorded even at 0 pre-retries.
    expect(getProtectStreamingStats().responses).toEqual({
      success: 0,
      exhausted: 0,
      retreated: 0,
      partialDegrade: 1,
      totalRetries: 0,
      retriesBeforeDegrade: 0,
      continuationExhausted: 0,
      precontentRecoverySuccess: 0,
      precontentRecoveryExhausted: 0,
      preFirstBlockRetries: 0,
      continuationRetries: 0,
    })
  })
})
