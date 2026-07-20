/**
 * WS terminal-only buffered retry — close-code(1011) timing lock (P4 Task 2,
 * block-level-buffered-retry plan-4 `plan-4-responses-ws.md` Task 2, backlog:300-306).
 *
 * P4 Task 1 shipped `/v1/responses` over WebSocket as a **terminal-only** buffered consumer of
 * `driver.runResponseBufferedSink` (`commitBoundaries` intentionally OMITTED — see ws.ts:373-388).
 * Because of that terminal-only shape, most of this task's brief invariants are either MOOT or
 * structurally unreachable rather than needing a guard:
 *
 *   - `stopAfterFrame` truncating the un-committed buffer: MOOT. `stopAfterFrame` is read ONLY by
 *     `runResponseSink` (driver.ts:490) — `runResponseBufferedSink` never reads `opts.stopAfterFrame`
 *     at all (grep confirms the single reference site). The buffered loop always drains its
 *     `for await` to the upstream's natural EOF/throw (driver.ts:635-707); it is not a `break`-able
 *     loop keyed off the terminal predicate. So passing `stopAfterFrame: isTerminal` into the
 *     buffered opts (ws.ts:395) is inert on this path — nothing to test.
 *   - Partial-degrade for WS: UNREACHABLE. `partial-degrade` only fires when `committedAny` is true
 *     (driver.ts:792), and `committedAny` is set ONLY by the `commitBoundaries` branch (driver.ts:698),
 *     which WS never wires (`commitBoundaries` is omitted, ws.ts:396-397). So a non-terminal drop on
 *     the WS path commits nothing and can only resolve `exhausted` (retries used up) or `retreated`
 *     (buffer-cap overflow) — never `partial-degrade`.
 *   - No premature 1011 during retries: structurally guaranteed, not merely tested-for. The retry
 *     loop lives ENTIRELY inside `runResponseBufferedSink` (driver.ts:628-794) — the WS handler
 *     `await`s the whole call (ws.ts:391-425) and only inspects `outcome.kind` AFTER it resolves
 *     (ws.ts:428-489). `sendErrorAndClose` (the only 1011-close call site on this path, ws.ts:437-450)
 *     is lexically unreachable until that await returns, so it cannot fire between attempts.
 *
 * What IS worth locking as regression tests (this file):
 *   1. success-after-retry → close(1000), and — the load-bearing version of "no premature 1011" —
 *      the wire NEVER carries an `error` frame nor a 1011 close during the whole exchange, proving
 *      the transparent retry leaked nothing to the client.
 *   2. exhausted (every attempt truncates before a terminal) → the client receives the error frame +
 *      `code === 1011` ONLY after the buffer is resolved, and NONE of the discarded attempts' partial
 *      content ever reaches the wire (terminal-only discards every un-committed buffer wholesale).
 *
 * Counterfactual proving test 1 is load-bearing (see the test body comment): a stray
 * `sendErrorAndClose` inserted into the retry path (simulated by temporarily forcing
 * `retryCap: 0` while `rstBeforeComplete: 1`, i.e. the retry that WOULD have saved the request is
 * disallowed) flips the assertions RED — `result.code` becomes 1011 and the error-frame guard trips.
 * Restored to the real (retry-capable) config, both flip back GREEN. This is exercised inline below
 * as its own describe block so the counterfactual is itself a permanent regression witness, not just
 * a one-off manual check.
 *
 * Fixture: the SAME `Bun.serve()` + `hono/bun` harness as `ws-buffered.integration.test.ts` — the P4
 * Task 1 review confirmed it faithfully reproduces server-emitted close codes
 * (`server-ws-close-code-tolerance.unit.test.ts`); this file reuses that exact pattern.
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

const MODEL = "gpt-5-ws-close-timing"

function baseResponse(model: string, status: ResponsesResponse["status"], usage: ResponsesResponse["usage"] = null): ResponsesResponse {
  return {
    id: "resp-ws-close-timing-test",
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
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "COMPLETE_ATTEMPT_FINAL", sequence_number: 1 })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 2, response: baseResponse(model, "completed", { input_tokens: 5, output_tokens: 3, total_tokens: 8 }) })}\n\n`,
  ]
}

/** A partial generation, then the upstream body ERRORS (deterministic mid-stream RST, no terminal). */
function partialFrames(model: string, tag: string): Array<string> {
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: baseResponse(model, "in_progress") })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: tag, sequence_number: 1 })}\n\n`,
  ]
}

const RST_ERROR = new Error("Stream closed with error code NGHTTP2_CANCEL")

let upstreamCalls = 0
/** Number of leading attempts that RST before the upstream finally completes (or forever, if >= cap+1). */
let rstBeforeComplete = 0

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
  const model = payload.model ?? MODEL

  if (url.endsWith("/responses")) {
    upstreamCalls += 1
    const rst = upstreamCalls <= rstBeforeComplete
    if (rst) return Promise.resolve(createSseResponseThenError(partialFrames(model, `PARTIAL_ATTEMPT_${upstreamCalls}`), RST_ERROR))
    return Promise.resolve(createSseResponse(completeFrames(model)))
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

/** Drive one `/v1/responses` WS round-trip against `server` and return the observed close. */
async function driveOneRequest(server: TestServerHandle): Promise<SocketCloseResult> {
  const ws = new WebSocket(`${server.url}/responses`)
  const closePromise = waitForSocketClose(ws)
  await waitForOpen(ws)
  ws.send(JSON.stringify({ type: "response.create", response: { model: MODEL, input: "hi" } }))
  return closePromise
}

describe("Responses WS buffered retry — close-code(1011) timing (P4 Task 2, backlog:300-306)", () => {
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
    setModels({
      object: "list",
      data: [mockModel(MODEL, { vendor: "OpenAI", supported_endpoints: ["/responses"] })],
    })
    applyFetchMock(upstreamFetchMock)
  })

  afterEach(() => {
    server?.stop()
    server = undefined
    closeAllClients()
  })

  test("success after a mid-stream retry closes 1000 — the wire NEVER carries an error frame or a 1011 close", async () => {
    setStateForTests({
      responsesBufferedRetry: true,
      bufferedRetryShared: { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 },
      streamKeepalivePingSec: 20,
    })
    rstBeforeComplete = 1 // attempt 1 RSTs mid-stream, attempt 2 (retry) completes — within cap

    server = startWsServer()
    const result = await driveOneRequest(server)

    // The transparent retry never leaked a close/error to the client — the ONLY close is the
    // terminal 1000 "done", and no `type: "error"` frame is anywhere on the wire.
    expect(result.code).toBe(1000)
    expect(result.reason).toBe("done")
    expect(result.messages.some((m) => m.type === "error")).toBe(false)
    expect(JSON.stringify(result.messages)).not.toContain("PARTIAL_ATTEMPT_1")
    expect(JSON.stringify(result.messages)).toContain("COMPLETE_ATTEMPT_FINAL")
    expect(upstreamCalls).toBe(2)

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    expect(getProtectStreamingStats().responses_ws).toEqual({
      success: 1,
      exhausted: 0,
      retreated: 0,
      partialDegrade: 0,
      totalRetries: 1,
      retriesBeforeDegrade: 0,
    })
  })

  test("exhausted (every attempt truncates) → error frame + 1011 close ONLY after the buffer resolves, no partial ever reaches the wire", async () => {
    setStateForTests({
      responsesBufferedRetry: true,
      bufferedRetryShared: { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 },
      streamKeepalivePingSec: 20,
    })
    rstBeforeComplete = 99 // EVERY attempt RSTs — the upstream never reaches a terminal

    server = startWsServer()
    const result = await driveOneRequest(server)

    // The client is closed with 1011 — but only ONE error frame, sent as the LAST message (i.e.
    // after the driver fully resolved the retry loop — see the invariant discussion in the file
    // header: `sendErrorAndClose` is lexically unreachable until `runResponseBufferedSink` returns).
    expect(result.code).toBe(1011)
    const errorFrames = result.messages.filter((m) => m.type === "error")
    expect(errorFrames).toHaveLength(1)
    expect(result.messages.at(-1)?.type).toBe("error")

    // Terminal-only discards every un-committed buffer wholesale — NONE of the 3 discarded
    // attempts' partial content (each attempt uses a distinct tag) ever reached the wire.
    const messageBlob = JSON.stringify(result.messages)
    expect(messageBlob).not.toContain("PARTIAL_ATTEMPT_1")
    expect(messageBlob).not.toContain("PARTIAL_ATTEMPT_2")
    expect(messageBlob).not.toContain("PARTIAL_ATTEMPT_3")

    // attempts == retryCap + 1 (3 upstream exchanges: original + 2 retries, all RST).
    expect(upstreamCalls).toBe(3)

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("failed")
    expect(getProtectStreamingStats().responses_ws).toEqual({
      success: 0,
      exhausted: 1,
      retreated: 0,
      partialDegrade: 0,
      totalRetries: 2,
      retriesBeforeDegrade: 0,
    })
  })

  describe("counterfactual: proves the success-no-1011 test above is load-bearing", () => {
    test("(RED without the retry budget) forcing retryCap:0 on the SAME mid-stream-drop scenario flips to a 1011 close with an error frame", async () => {
      // Same upstream script as the "success after retry" test above (attempt 1 RSTs, attempt 2
      // would complete) — but the retry budget is starved to 0, so the driver can't take the retry
      // that would have saved the request. If the "no premature 1011" test above were NOT actually
      // exercising the close-timing path (e.g. a vacuous assertion, or the fixture not truly
      // reproducing server close codes), this counterfactual would ALSO pass with code 1000 — it
      // does not, which is the proof the real test is load-bearing.
      setStateForTests({
        responsesBufferedRetry: true,
        bufferedRetryShared: { maxRetries: 0, bufferCapBytes: 16_777_216, heartbeatSec: 15 },
        streamKeepalivePingSec: 20,
      })
      rstBeforeComplete = 1 // attempt 1 RSTs; with retryCap:0 there is no attempt 2 — exhausted

      server = startWsServer()
      const result = await driveOneRequest(server)

      expect(result.code).toBe(1011)
      expect(result.messages.some((m) => m.type === "error")).toBe(true)
      expect(upstreamCalls).toBe(1)

      const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
      expect(entry?.state).toBe("failed")
    })
  })
})
