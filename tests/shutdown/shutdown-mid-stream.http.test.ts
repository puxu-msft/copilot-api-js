/**
 * HTTP-level regression for the `guardSseIterable` shutdown integration.
 *
 * The unit suite (`tests/streaming/stream-guard.unit.test.ts`) proves the helper itself
 * forwards the stable process-global shutdown signal into a local controller, so
 * a `.next()` already blocked on a stalled upstream is still woken by the Phase 3
 * abort. These tests prove each of the three SSE-forwarding handlers
 * (chat-completions, responses, gemini) actually passes `getShutdownSignal()`
 * into the helper — a future hand-edit dropping that wiring would silently
 * regress: shutdown-after-stream-start would no longer terminate the in-flight
 * response.
 *
 * Mitigation for shared module state: each test triggers `gracefulShutdown`
 * with FAST timing overrides (50ms phase2 + 50ms phase3) and a stub server, so
 * the abort-controller side effect on `~/lib/shutdown` module state never
 * leaks past the test. `resetTestRuntime()` in afterEach calls
 * `_resetShutdownState()` which clears the controller.
 */

import {
  //
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { gracefulShutdown } from "~/lib/shutdown"
import {
  //
  type StateSnapshot,
  restoreStateForTests,
  setModels,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import {
  //
  applyFetchMock,
  restoreFetch,
  setFetchMock,
} from "../helpers/mock-fetch"
import { createMockServer } from "../helpers/mock-server"
import { createMockTracker } from "../helpers/mock-tracker"
import {
  //
  bootstrapTestRuntime,
  resetTestRuntime,
} from "../helpers/test-bootstrap"

// ============================================================================
// Mocks
// ============================================================================

// ----- chat-completions upstream fetch mock -----
//
// Runs the real `createChatCompletions` client against a mocked `globalThis.fetch`
// (process-global `mock.module` leaks into sibling test files). The upstream
// returns an SSE response that emits one frame then stays open forever — the
// handler's `guardSseIterable` stream guard must observe the shutdown
// abort signal to terminate the in-flight response.
const chatCompletionsFetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string; stream?: boolean }) : {}

  if (url.endsWith("/chat/completions")) {
    if (!payload.stream) throw new Error("expected streaming payload")
    return makeBlockingSseResponse([
      `data: ${JSON.stringify({
        id: "chatcmpl-shutdown-test",
        object: "chat.completion.chunk",
        created: 1,
        model: payload.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null, logprobs: null }],
      })}\n\n`,
    ])
  }

  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

// ----- responses upstream fetch mock -----
function makeBlockingSseResponse(initialFrames: ReadonlyArray<string>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of initialFrames) {
        controller.enqueue(encoder.encode(frame))
      }
      // Leave the controller open forever — emulates an upstream that has gone
      // silent but kept the TCP connection alive.
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

// ============================================================================
// Test helpers
// ============================================================================

const SHUTDOWN_BOUND_MS = 500

/** Fast-timing graceful shutdown that fires Phase 3 abort within ~10ms. */
function fastGracefulShutdown(): Promise<void> {
  // Tracker reports one active request so Phase 2 → Phase 3 transition runs
  // (Phase 3 is where shutdownAbortController.abort() fires). The request never
  // actually leaves the tracker in this stub, so we exit via Phase 4 (force
  // close) — but the SSE response should already be closed by then thanks to
  // the abort signal observed by guardSseIterable.
  return gracefulShutdown("SIGTERM", {
    tracker: createMockTracker([{ status: "streaming" }]),
    server: createMockServer(),
    rateLimiter: null,
    stopTokenRefreshFn: mock(() => {}),
    closeAllClientsFn: mock(() => {}),
    getClientCountFn: () => 0,
    gracefulWaitMs: 50,
    abortWaitMs: 50,
    drainPollIntervalMs: 10,
    drainProgressIntervalMs: 50_000,
  })
}

/**
 * Read SSE frames from the response body until either the stream closes or the
 * deadline elapses. Returns the accumulated body text plus whether it closed,
 * so callers can assert a terminal error event was emitted before the close.
 */
async function drainUntilClosed(body: ReadableStream<Uint8Array>, timeoutMs: number): Promise<{ closed: boolean; text: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), remaining))
      const next = reader.read().then((r) => (r.done ? "done" : { chunk: r.value }))
      const winner = await Promise.race([timer, next])
      if (winner === "done") return { closed: true, text }
      if (winner === "timeout") return { closed: false, text }
      text += decoder.decode(winner.chunk, { stream: true })
      // chunk: keep draining
    }
    return { closed: false, text }
  } finally {
    reader.releaseLock()
  }
}

// ============================================================================
// Tests
// ============================================================================

let snapshot: StateSnapshot

beforeAll(async () => {
  await bootstrapTestRuntime()
})

beforeEach(() => {
  snapshot = snapshotStateForTests()
  chatCompletionsFetchMock.mockClear()
  // The real chat-completions client checks state.copilotToken before issuing fetch.
  // Tests hitting the /responses upstream override the fetch mock themselves.
  setStateForTests({
    copilotToken: "test-token",
    accountType: "individual",
    vsCodeVersion: "1.100.0",
    responseHeaderTimeout: 0,
  })
  applyFetchMock(chatCompletionsFetchMock)
})

afterEach(async () => {
  restoreFetch()
  restoreStateForTests(snapshot)
  // Always reset shutdown state even if a test failed mid-shutdown — leaving
  // _isShuttingDown=true would poison every later test in the suite.
  await resetTestRuntime()
  // Give any pending shutdown timers one tick to settle.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
})

describe("chat-completions handler — mid-stream shutdown closes the SSE response", () => {
  test("first event arrives, then shutdown aborts the stream within SHUTDOWN_BOUND_MS", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })

    const { createFullTestApp } = await import("../helpers/test-app")
    const app = createFullTestApp()

    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "stream please" }],
        stream: true,
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    if (!res.body) throw new Error("expected response body")

    // Fire shutdown — Phase 3 abort reaches the stable shutdown signal inside
    // guardSseIterable, which throws StreamShutdownError; the handler's catch
    // emits a terminal retryable error event before closing the stream.
    const shutdownPromise = fastGracefulShutdown()
    const { closed, text } = await drainUntilClosed(res.body, SHUTDOWN_BOUND_MS)
    expect(closed).toBe(true)
    expect(text).toContain("server_error")
    await shutdownPromise
  })
})

describe("responses handler — mid-stream shutdown closes the SSE response", () => {
  test("first event arrives, then shutdown aborts the stream within SHUTDOWN_BOUND_MS", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })
    setStateForTests({ copilotToken: "test-token" })

    setFetchMock(async () =>
      makeBlockingSseResponse([
        `event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          sequence_number: 0,
          response: {
            id: "resp-shutdown-test",
            object: "response",
            created_at: 1,
            status: "in_progress",
            model: "gpt-4o",
            output: [],
            usage: null,
            tools: [],
            tool_choice: "auto",
            parallel_tool_calls: false,
            store: false,
          },
        })}\n\n`,
      ]),
    )

    const { createFullTestApp } = await import("../helpers/test-app")
    const app = createFullTestApp()

    const res = await app.request("/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: "stream please",
        stream: true,
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    if (!res.body) throw new Error("expected response body")

    const shutdownPromise = fastGracefulShutdown()
    const { closed, text } = await drainUntilClosed(res.body, SHUTDOWN_BOUND_MS)
    expect(closed).toBe(true)
    expect(text).toContain("server_error")
    await shutdownPromise
  })
})

describe("gemini handler — mid-stream shutdown closes the SSE response", () => {
  test("first event arrives, then shutdown aborts the stream within SHUTDOWN_BOUND_MS", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })

    const { createFullTestApp } = await import("../helpers/test-app")
    const app = createFullTestApp()

    const res = await app.request("/v1beta/models/gpt-4o:streamGenerateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "stream please" }] }],
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    if (!res.body) throw new Error("expected response body")

    const shutdownPromise = fastGracefulShutdown()
    const { closed, text } = await drainUntilClosed(res.body, SHUTDOWN_BOUND_MS)
    expect(closed).toBe(true)
    expect(text).toContain("UNAVAILABLE")
    await shutdownPromise
  })
})
