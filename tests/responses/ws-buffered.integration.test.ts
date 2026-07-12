/**
 * WS terminal-only buffered retry (P4 Task 1, block-level-buffered-retry spec §7.3).
 *
 * With `responsesBufferedRetry` ENABLED, `/v1/responses` over WebSocket routes through the driver's
 * `runResponseBufferedSink` — the SAME shared primitive the HTTP Responses/Anthropic/CC pumps use —
 * instead of the live `runResponseSink`. Terminal-only: WS has no mid-stream block/anchor needs, so
 * the commit boundary set only contains the lifecycle terminals (byte-equivalent in spirit to the
 * whole-response buffered shape). Asserts:
 *   1. buffered ON: attempt 1 drops mid-stream (upstream body errors before response.completed),
 *      attempt 2 completes → the client receives ONLY the complete second generation over the socket
 *      (no attempt-1 partial leaks), history `completed`, upstream exchanged twice, hit-rate telemetry
 *      records the save-after-retry under the `responses_ws` vendor bucket.
 *   2. `stopAfterFrame:isTerminal` does not truncate the buffered accumulation mid-retry: the
 *      client-visible frame sequence is exactly the SECOND (complete) generation's frames, proving the
 *      early-stop predicate operates on the post-commit write-out, not on the buffering itself.
 *   3. via-chat-completions fallback + buffered=true stays on the LIVE sink (regression parity with
 *      the HTTP handler's P2 Task 3 exclusion) — one upstream call, no buffered-retry telemetry.
 *
 * WS test fixture: `Bun.serve()` + `hono/bun` (the SAME harness `responses-ws.http.test.ts` /
 * `responses-ws-keepalive.unit.test.ts` / `server-ws-close-code-tolerance.unit.test.ts` already use for
 * this exact client-facing WS endpoint — 28+ passing scenarios including truncation/close-code/
 * keepalive). The plan brief's "Bun WS server is unfaithful, use Node ws/http2" caution (skill
 * `bun-upstream-transport`) is about *upstream* HTTP/h2 transport gotchas (300s timeout, missing
 * keepalive, REFUSED_STREAM classification) — NOT this downstream/client-facing WS surface. The one
 * documented client-WS unfaithfulness (a client-initiated `ws.close()` doesn't reliably propagate to
 * the server's `onClose` in this bare-Hono+Bun.serve harness — see responses-ws.http.test.ts:522-534)
 * is irrelevant here: this scenario drives an UPSTREAM HTTP SSE drop (fetch mock), not a client-side
 * disconnect, so the client socket lifecycle is unaffected.
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
import {
  //
  upgradeWebSocket,
  websocket,
} from "hono/bun"

import type { ResponsesResponse } from "~/types/api/openai-responses"

import { getProtectStreamingStats } from "~/lib/anthropic/protect-streaming-stats"
import { getHistory } from "~/lib/history"
import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"
import { closeAllClients } from "~/lib/ws"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import {
  //
  createSseResponse,
  createSseResponseThenError,
} from "../helpers/sse"

const MODEL = "gpt-5-ws"

function baseResponse(model: string, status: ResponsesResponse["status"], usage: ResponsesResponse["usage"] = null): ResponsesResponse {
  return {
    id: "resp-ws-buffered-test",
    object: "response",
    created_at: 1,
    status,
    model,
    output: [],
    usage,
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
  }
}

/** A complete direct-Responses generation (distinctive delta text so a leaked partial is detectable). */
function completeFrames(model: string): Array<string> {
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: baseResponse(model, "in_progress") })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "COMPLETE_ATTEMPT_2", sequence_number: 1 })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 2, response: baseResponse(model, "completed", { input_tokens: 5, output_tokens: 3, total_tokens: 8 }) })}\n\n`,
  ]
}

/** A partial generation, then the upstream body ERRORS (deterministic mid-stream RST, no [DONE]). */
function partialFrames(model: string): Array<string> {
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: baseResponse(model, "in_progress") })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "PARTIAL_ATTEMPT_1", sequence_number: 1 })}\n\n`,
  ]
}

/** A clean one-shot CC (`/chat/completions`) SSE stream — mirrors responses-buffered.it.test.ts's ccStreamFrames. */
function ccStreamFrames(model: string): Array<string> {
  return [
    `data: ${JSON.stringify({ id: "chatcmpl-ws-fallback", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: "FALLBACK_REPLY" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "chatcmpl-ws-fallback", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ]
}

const RST_ERROR = new Error("Stream closed with error code NGHTTP2_CANCEL")

let upstreamCalls = 0
/** Number of leading attempts that RST before the upstream finally completes. */
let rstBeforeComplete = 0

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
    const rst = upstreamCalls <= rstBeforeComplete
    return Promise.resolve(rst ? createSseResponseThenError(partialFrames(model), RST_ERROR) : createSseResponse(completeFrames(model)))
  }
  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

interface TestServerHandle {
  stop: () => void
  url: string
}

const { registerWsRoutes } = await import("~/routes")

function startWsServer(): TestServerHandle {
  const app = new Hono()
  registerWsRoutes(app, upgradeWebSocket)

  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      return app.fetch(request, { server: bunServer })
    },
    websocket,
  })

  return {
    url: `ws://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  }
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error("WebSocket failed to open"))
    }
    const cleanup = () => {
      ws.removeEventListener("open", onOpen)
      ws.removeEventListener("error", onError)
    }
    ws.addEventListener("open", onOpen, { once: true })
    ws.addEventListener("error", onError, { once: true })
  })
}

interface SocketCloseResult {
  code: number
  messages: Array<Record<string, unknown>>
  reason: string
}

function waitForSocketClose(ws: WebSocket, timeoutMs = 5000): Promise<SocketCloseResult> {
  return new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = []
    const timeout = setTimeout(() => {
      cleanup()
      try {
        ws.close()
      } catch {
        // ignore close errors during timeout cleanup
      }
      reject(new Error(`Timed out waiting for WebSocket close after ${timeoutMs}ms`))
    }, timeoutMs)

    const onMessage = (event: MessageEvent) => {
      messages.push(JSON.parse(String(event.data)) as Record<string, unknown>)
    }
    const onClose = (event: CloseEvent) => {
      cleanup()
      resolve({ code: event.code, messages, reason: event.reason })
    }
    const onError = () => {
      cleanup()
      reject(new Error("WebSocket error before close"))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("close", onClose)
      ws.removeEventListener("error", onError)
    }

    ws.addEventListener("message", onMessage)
    ws.addEventListener("close", onClose, { once: true })
    ws.addEventListener("error", onError, { once: true })
  })
}

describe("Responses WS buffered retry (P4 Task 1)", () => {
  useIsolatedRuntime()

  let server: TestServerHandle | undefined

  beforeEach(() => {
    upstreamCalls = 0
    rstBeforeComplete = 0
    upstreamFetchMock.mockClear()
    setStateForTests({
      accountType: "individual",
      copilotToken: "copilot-test-token",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      upstreamWebSocket: false,
    })
    applyFetchMock(upstreamFetchMock)
  })

  afterEach(() => {
    server?.stop()
    server = undefined
    closeAllClients()
  })

  test("buffered ON: mid-stream upstream drop before terminal → retried & recovered, client sees ONE complete generation", async () => {
    setModels({
      object: "list",
      data: [mockModel(MODEL, { vendor: "OpenAI", supported_endpoints: ["/responses"] })],
    })
    setStateForTests({
      responsesBufferedRetry: true,
      bufferedRetryShared: { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 },
      streamKeepalivePingSec: 20,
    })
    rstBeforeComplete = 1 // attempt 1 RSTs mid-stream, attempt 2 (retry) completes

    server = startWsServer()
    const ws = new WebSocket(`${server.url}/responses`)
    const closePromise = waitForSocketClose(ws)
    await waitForOpen(ws)
    ws.send(JSON.stringify({ type: "response.create", response: { model: MODEL, input: "hi" } }))

    const result = await closePromise

    // The client received ONLY the complete second generation — the attempt-1 partial never leaked
    // over the wire (proves stopAfterFrame:isTerminal did not truncate the buffered accumulation:
    // the frames actually written are exactly the COMMITTED generation's, not a half-buffered mix).
    const messageBlob = JSON.stringify(result.messages)
    expect(messageBlob).not.toContain("PARTIAL_ATTEMPT_1")
    expect(messageBlob).toContain("COMPLETE_ATTEMPT_2")
    expect(result.messages.map((m) => m.type)).toEqual(["response.created", "response.output_text.delta", "response.completed"])
    expect(result.code).toBe(1000)
    expect(result.reason).toBe("done")

    // 2 upstream exchanges (1 RST + 1 complete) — the retry is transparent to the client.
    expect(upstreamCalls).toBe(2)

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    expect(entry?.attempts?.at(-1)?.upstreamResponse?.success).toBe(true)

    // Hit-rate telemetry: one save after 1 retry, under the distinct `responses_ws` vendor bucket
    // (separable from HTTP's `responses` bucket in /api/status.protect_streaming.by_vendor).
    expect(getProtectStreamingStats().responses_ws).toEqual({
      success: 1,
      exhausted: 0,
      retreated: 0,
      partialDegrade: 0,
      totalRetries: 1,
      retriesBeforeDegrade: 0,
    })
  })

  test("buffered ON + via-chat-completions fallback stays LIVE (no spurious retry, no buffered telemetry)", async () => {
    setModels({
      object: "list",
      data: [mockModel(MODEL, { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] })],
    })
    setStateForTests({
      responsesBufferedRetry: true,
      bufferedRetryShared: { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 },
      streamKeepalivePingSec: 20,
    })

    server = startWsServer()
    const ws = new WebSocket(`${server.url}/responses`)
    const closePromise = waitForSocketClose(ws)
    await waitForOpen(ws)
    ws.send(JSON.stringify({ type: "response.create", response: { model: MODEL, input: "hi" } }))

    const result = await closePromise

    expect(result.messages.map((m) => m.type)).toContain("response.completed")
    expect(result.code).toBe(1000)
    expect(upstreamCalls).toBe(1) // NOT retried — the fallback path never engages the buffered sink

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    // The fallback path never engages `runResponseBufferedSink` — `onBufferedResolve` is never
    // invoked, so no vendor bucket is ever created (verified empirically against the real stats map).
    expect(getProtectStreamingStats()).toEqual({})
  })
})
