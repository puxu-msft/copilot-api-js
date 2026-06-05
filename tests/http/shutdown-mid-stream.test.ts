/**
 * HTTP-level regression for the `guardSseIterable` shutdown integration.
 *
 * The unit suite (`tests/unit/stream-guard.test.ts`) proves the helper itself
 * recomputes its abort signal per iteration. These tests prove each of the
 * three SSE-forwarding handlers (chat-completions, responses, gemini) actually
 * wires a *thunk* into the helper — a future hand-edit like
 * `const sig = combineAbortSignals(...); { getAbortSignal: () => sig }` would
 * silently regress: shutdown-after-stream-start would no longer terminate the
 * in-flight response.
 *
 * Mitigation for shared module state: each test triggers `gracefulShutdown`
 * with FAST timing overrides (50ms phase2 + 50ms phase3) and a stub server, so
 * the abort-controller side effect on `~/lib/shutdown` module state never
 * leaks past the test. `resetTestRuntime()` in afterEach calls
 * `_resetShutdownState()` which clears the controller.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

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

import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { prepareChatCompletionsRequest } from "~/lib/openai/request-preparation"
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

/** Yields one frame from each `chunks` entry, then blocks forever. */
function blockingAfterChunks(chunks: ReadonlyArray<ServerSentEventMessage>): AsyncGenerator<ServerSentEventMessage> {
  return (async function* () {
    for (const chunk of chunks) yield chunk
    // Block forever — caller must rely on the shutdown abort signal to terminate.
    await new Promise<void>(() => {
      // never resolves
    })
  })()
}

// ----- chat-completions mock -----
const chatCompletionsMock = mock(async (payload: ChatCompletionsPayload) => {
  if (!payload.stream) throw new Error("expected streaming payload")
  return blockingAfterChunks([
    {
      event: "message",
      data: JSON.stringify({
        id: "chatcmpl-shutdown-test",
        object: "chat.completion.chunk",
        created: 1,
        model: payload.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null, logprobs: null }],
      }),
    },
  ])
})

mock.module("~/lib/openai/chat-completions-client", () => ({
  createChatCompletions: chatCompletionsMock,
  prepareChatCompletionsRequest,
}))

// ----- responses upstream fetch mock -----
const originalFetch = globalThis.fetch

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
 * Read SSE frames from the response body until either a frame count is hit or
 * the stream closes. Returns true when the stream ends; false on timeout.
 */
async function drainUntilClosed(body: ReadableStream<Uint8Array>, timeoutMs: number): Promise<boolean> {
  const reader = body.getReader()
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), remaining))
      const next = reader.read().then((r) => (r.done ? "done" : "chunk"))
      const winner = await Promise.race([timer, next])
      if (winner === "done") return true
      if (winner === "timeout") return false
      // chunk: keep draining
    }
    return false
  } finally {
    reader.releaseLock()
  }
}

// ============================================================================
// Tests
// ============================================================================

let snapshot: StateSnapshot

beforeAll(() => {
  bootstrapTestRuntime()
})

beforeEach(() => {
  snapshot = snapshotStateForTests()
  chatCompletionsMock.mockClear()
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  restoreStateForTests(snapshot)
  // Always reset shutdown state even if a test failed mid-shutdown — leaving
  // _isShuttingDown=true would poison every later test in the suite.
  resetTestRuntime()
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

    // Fire shutdown — Phase 3 abort hits the per-iteration thunk inside
    // guardSseIterable and ends the for-await loop cleanly.
    const shutdownPromise = fastGracefulShutdown()
    const closed = await drainUntilClosed(res.body, SHUTDOWN_BOUND_MS)
    expect(closed).toBe(true)
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

    globalThis.fetch = mock(async () =>
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
    ) as unknown as typeof fetch

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
    const closed = await drainUntilClosed(res.body, SHUTDOWN_BOUND_MS)
    expect(closed).toBe(true)
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
    const closed = await drainUntilClosed(res.body, SHUTDOWN_BOUND_MS)
    expect(closed).toBe(true)
    await shutdownPromise
  })
})
