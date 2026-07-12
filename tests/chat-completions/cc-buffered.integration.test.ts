/**
 * Chat Completions buffered-retry adoption (P3 Task 2) — http end-to-end.
 *
 * With `chatCompletionsBufferedRetry` ENABLED, the CC `/chat/completions` streaming pump
 * selects `driver.runResponseBufferedSink`: it buffers the rendered generation and, on a
 * clean drain WITHOUT `finish_reason` (CC has no mid-stream block boundary — the commit
 * predicate is terminal-only, `ccCommitBoundaries`), discards the buffer + re-exchanges,
 * transparently delivering ONE complete generation to the client. Mirrors
 * tests/responses/responses-buffered.it.test.ts / tests/anthropic/streaming-l2-buffered.http.test.ts.
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
  setBufferedRetryOverride,
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
} from "../helpers/sse"

const MODEL = "gpt-4o"

/** A complete CC generation: a content delta + a terminal finish_reason chunk + [DONE]. */
function completeFrames(model: string): Array<string> {
  return [
    `data: ${JSON.stringify({ id: "s2", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "COMPLETE_ATTEMPT_2" }, finish_reason: null, logprobs: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "s2", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }] })}\n\n`,
    "data: [DONE]\n\n",
  ]
}

/** A partial CC generation: a content delta, then a clean EOF — NO finish_reason chunk. */
function partialFrames(model: string): Array<string> {
  return [
    `data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "PARTIAL_ATTEMPT_1" }, finish_reason: null, logprobs: null }] })}\n\n`,
    // EOF — no finish_reason chunk, no [DONE].
  ]
}

/** Number of leading upstream attempts that drain cleanly WITHOUT a finish_reason (truncation). */
let rstBeforeComplete = 0
/** When true, EVERY attempt truncates (retries exhausted scenario). */
let alwaysTruncate = false
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
    const truncate = alwaysTruncate || upstreamCalls <= rstBeforeComplete
    return Promise.resolve(createSseResponse(truncate ? partialFrames(model) : completeFrames(model)))
  }
  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

async function streamRequest(): Promise<Response> {
  setDisabledModels([])
  setModels({ object: "list", data: [mockModel(MODEL, { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] })] })
  return app.request("/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], stream: true }),
  })
}

describe("CC buffered-retry adoption (P3 Task 2)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    upstreamCalls = 0
    rstBeforeComplete = 0
    alwaysTruncate = false
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
    })
    applyFetchMock(upstreamFetchMock)
  })

  test("CC buffered: truncate before finish_reason → retried & recovered + synthesized [DONE]", async () => {
    setStateForTests({ chatCompletionsBufferedRetry: true, streamKeepalivePingSec: 20 })
    // Per-vendor override (not the shared cap): `processOpenAIMessages` calls `applyConfigToState()`
    // unconditionally on every CC request, which reloads the bundled config.yaml's top-level
    // `buffered_retry.max_retries` and clobbers `state.bufferedRetryShared` via `setBufferedRetryShared`
    // — the per-vendor `chat_completions` override map is untouched by that reload (the bundled config
    // ships no `chat_completions.buffered_retry` key), so it survives.
    setBufferedRetryOverride("chat_completions", { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 })
    rstBeforeComplete = 1 // attempt 1 truncates (no finish_reason), attempt 2 (retry) completes

    const sse = await (await streamRequest()).text()

    // The client sees ONLY the final complete generation — the attempt-1 partial never leaks.
    expect(sse).not.toContain("PARTIAL_ATTEMPT_1")
    expect(sse).toContain("COMPLETE_ATTEMPT_2")
    // The final frame carries the terminal finish_reason.
    expect(sse).toContain('"finish_reason":"stop"')
    // The handler's post-loop [DONE] synthesis is appended AFTER the buffered commit.
    expect(sse).toContain("[DONE]")
    expect(sse).not.toContain("event: error")
    expect(sse).not.toContain("truncated")

    // 2 upstream exchanges (1 truncation + 1 complete).
    expect(upstreamCalls).toBe(2)

    const entry = getHistory({ endpoint: "openai-chat-completions", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    expect(entry?.attempts?.at(-1)?.upstreamResponse?.success).toBe(true)
    // Per-attempt isolation (onAttemptReset): the committed generation's derived content is ONLY
    // attempt 2's — the discarded attempt-1 partial must NOT leak into the history record.
    const committedBody = JSON.stringify(entry?.attempts?.at(-1)?.upstreamResponse?.body)
    expect(committedBody).toContain("COMPLETE_ATTEMPT_2")
    expect(committedBody).not.toContain("PARTIAL_ATTEMPT_1")
    // Hit-rate telemetry: one save after 1 retry, under the `chat_completions` vendor.
    expect(getProtectStreamingStats().chat_completions).toEqual({
      success: 1,
      exhausted: 0,
      retreated: 0,
      partialDegrade: 0,
      totalRetries: 1,
      retriesBeforeDegrade: 0,
    })
  })

  test("CC buffered: a clean first-try commit is NOT counted as a retry", async () => {
    setStateForTests({ chatCompletionsBufferedRetry: true, streamKeepalivePingSec: 20 })
    setBufferedRetryOverride("chat_completions", { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 })
    rstBeforeComplete = 0 // upstream completes first try — the buffered happy path, zero retries

    const sse = await (await streamRequest()).text()
    expect(sse).toContain('"finish_reason":"stop"')
    expect(sse).toContain("[DONE]")
    expect(upstreamCalls).toBe(1)

    const entry = getHistory({ endpoint: "openai-chat-completions", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    // L2 never ENGAGED (no truncation) → no telemetry (would otherwise inflate the hit-rate).
    expect(getProtectStreamingStats()).toEqual({})
  })

  test("CC buffered EXHAUSTION: every attempt truncates up to retryCap → settle FAIL, exhausted outcome", async () => {
    setStateForTests({ chatCompletionsBufferedRetry: true, streamKeepalivePingSec: 20 })
    setBufferedRetryOverride("chat_completions", { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 })
    alwaysTruncate = true // EVERY attempt truncates — the upstream never reaches a finish_reason

    const sse = await (await streamRequest()).text()

    // All-or-nothing: nothing committed → the client gets ZERO content frames, only the synthetic
    // error terminator (the buffered path never live-forwards a discarded attempt's partial).
    expect(sse).not.toContain("PARTIAL_ATTEMPT_1")
    expect(sse).toContain("event: error")
    expect(sse).not.toContain("[DONE]")

    // attempts == retryCap + 1 (3 upstream exchanges: original + 2 retries, all truncated).
    expect(upstreamCalls).toBe(3)

    const entry = getHistory({ endpoint: "openai-chat-completions", limit: 5 }).entries[0]
    expect(entry?.state).toBe("failed")
    expect(entry?.attempts?.at(-1)?.upstreamResponse?.success).toBe(false)
    expect(entry?._index?.derived?.attemptCount).toBe(3)
    expect(getProtectStreamingStats().chat_completions).toEqual({
      success: 0,
      exhausted: 1,
      retreated: 0,
      partialDegrade: 0,
      totalRetries: 2,
      retriesBeforeDegrade: 0,
    })
  })

  test("CC live mode (default off) fails a mid-stream truncation and preserves the partial (unchanged)", async () => {
    setStateForTests({ chatCompletionsBufferedRetry: false })
    rstBeforeComplete = 99 // every attempt truncates — but live never retries

    const sse = await (await streamRequest()).text()

    // Live forwards frames as they arrive — the partial IS on the wire…
    expect(sse).toContain("PARTIAL_ATTEMPT_1")
    // …terminated by an OpenAI error frame (the truncation terminator).
    expect(sse).toContain("event: error")
    expect(sse).toContain("truncated")
    expect(sse).not.toContain("[DONE]")
    expect(upstreamCalls).toBe(1) // no retry

    const entry = getHistory({ endpoint: "openai-chat-completions", limit: 5 }).entries[0]
    expect(entry?.state).toBe("failed")
    expect(entry?.attempts?.at(-1)?.upstreamResponse?.success).toBe(false)
  })
})
