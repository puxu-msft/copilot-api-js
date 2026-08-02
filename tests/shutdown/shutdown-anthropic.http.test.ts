/**
 * HTTP-level regression for graceful-shutdown interruption of the Anthropic
 * `/v1/messages` streaming path — the route Claude Code CLI actually uses.
 *
 * A mid-stream Phase 3 abort must surface a terminal `overloaded_error` event to
 * the still-connected client (retryable) instead of silently truncating the SSE
 * stream. Before the fix the handler treated the shutdown abort like a natural
 * `[DONE]`, marked the request `complete`, and closed the stream with no terminal
 * event → Claude Code reported "Stream ended without receiving any events".
 *
 * Rather than stubbing `~/lib/anthropic/client` (process-global `mock.module`
 * leaks into sibling suites that exercise the real client), this drives the REAL
 * client/handler against a mocked `globalThis.fetch`: the upstream SSE response
 * emits one `message_start` frame then blocks forever, so the handler's
 * stream shutdown guard (processAnthropicStream + catch) is exercised
 * deterministically. The non-streaming 529 translation lives in the real client
 * and is covered by a focused unit test in `tests/anthropic/anthropic-client.it.test.ts`.
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

import { setModels } from "~/lib/models/cache"
import { gracefulShutdown } from "~/lib/shutdown"
import {
  //
  type StateSnapshot,
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import {
  //
  applyFetchMock,
  restoreFetch,
} from "../helpers/mock-fetch"
import { createMockServer } from "../helpers/mock-server"
import { createMockTracker } from "../helpers/mock-tracker"
import {
  //
  bootstrapTestRuntime,
  resetTestRuntime,
} from "../helpers/test-bootstrap"

const CLAUDE_MODEL = "claude-sonnet-4.6"

/**
 * Build a streaming `Response` that emits a single `message_start` SSE frame and
 * then blocks forever — the real handler's stream shutdown guard must end
 * it. `events(response)` reads this body; once the shutdown abort fires the guard
 * breaks the loop, so the stream never needs to close on its own.
 */
function blockingMessageStartResponse(): Response {
  const encoder = new TextEncoder()
  const frame = `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: {
      id: "msg-shutdown-test",
      type: "message",
      role: "assistant",
      model: CLAUDE_MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  })}\n\n`

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frame))
      // Intentionally never enqueue more / never close: the shutdown guard ends it.
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

const upstreamFetchMock = mock(async (input: string | URL | Request) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  if (url.endsWith("/v1/messages")) {
    return blockingMessageStartResponse()
  }
  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

/** Fast-timing graceful shutdown that fires Phase 3 abort within ~10ms. */
function fastGracefulShutdown(): Promise<void> {
  return gracefulShutdown("SIGTERM", {
    tracker: createMockTracker([{ status: "streaming" }]),
    server: createMockServer(),
    rateLimiter: null,
    stopTokenRefreshFn: () => {},
    closeAllClientsFn: () => {},
    getClientCountFn: () => 0,
    gracefulWaitMs: 50,
    abortWaitMs: 50,
    drainPollIntervalMs: 10,
    drainProgressIntervalMs: 50_000,
  })
}

/** Read the response body to completion (or deadline), returning the text. */
async function readBody(body: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
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
      if (winner === "done" || winner === "timeout") return text
      text += decoder.decode(winner.chunk, { stream: true })
    }
    return text
  } finally {
    reader.releaseLock()
  }
}

let snapshot: StateSnapshot

beforeAll(async () => {
  await bootstrapTestRuntime()
})

beforeEach(() => {
  snapshot = snapshotStateForTests()
  upstreamFetchMock.mockClear()
  // The real anthropic client checks state.copilotToken before issuing fetch.
  setStateForTests({
    copilotToken: "test-token",
    accountType: "individual",
    vsCodeVersion: "1.100.0",
    responseHeaderTimeout: 0,
  })
  applyFetchMock(upstreamFetchMock)
  setModels({
    object: "list",
    data: [mockModel(CLAUDE_MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })],
  })
})

afterEach(async () => {
  restoreFetch()
  restoreStateForTests(snapshot)
  await resetTestRuntime()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
})

describe("Anthropic /v1/messages — mid-stream shutdown emits a retryable error event", () => {
  test("streaming: first event arrives, then shutdown emits overloaded_error", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "stream please" }],
      }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    if (!res.body) throw new Error("expected response body")

    const shutdownPromise = fastGracefulShutdown()
    const text = await readBody(res.body, 1000)
    // Terminal retryable error event delivered before the stream closed.
    expect(text).toContain("overloaded_error")
    await shutdownPromise
  })
})
