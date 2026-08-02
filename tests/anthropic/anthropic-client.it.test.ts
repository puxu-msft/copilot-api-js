import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type { MessagesPayload } from "~/types/api/anthropic"

import {
  //
  createAnthropicMessages,
  postAnthropicUpstream,
} from "~/lib/anthropic/client"
import { HTTPError } from "~/lib/error"
import { cancellationAbortError } from "~/lib/error/cancellation-reason"
import {
  //
  _resetShutdownState,
  getShutdownSignal,
  gracefulShutdown,
  SHUTDOWN_ABORT_MESSAGE,
} from "~/lib/shutdown"
import { setStateForTests } from "~/lib/state"

import {
  //
  autoRestoreFetch,
  setFetchMock,
} from "../helpers/mock-fetch"
import { createMockServer } from "../helpers/mock-server"
import { createMockTracker } from "../helpers/mock-tracker"
import { createSseResponse } from "../helpers/sse"
import { autoRestoreState } from "../helpers/state-fixture"

function createPayload(overrides: Partial<MessagesPayload> = {}): MessagesPayload {
  return {
    model: "claude-sonnet-4.6",
    max_tokens: 128,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    ...overrides,
  }
}

describe("anthropic client", () => {
  autoRestoreFetch()
  autoRestoreState()

  beforeEach(() => {
    setStateForTests({
      accountType: "individual",
      copilotToken: "copilot-test-token",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      contextEditingMode: "off",
    })
  })

  test("returns JSON responses and captures raw headers (Phase 1: History stores unredacted)", async () => {
    const fetchMock = setFetchMock(
      async () =>
        new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4.6",
            content: [{ type: "text", text: "hello back" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 10,
              output_tokens: 5,
            },
          }),
          {
            status: 200,
            headers: { "x-request-id": "resp-1" },
          },
        ),
    )

    const headersCapture: {
      request?: Record<string, string>
      response?: Record<string, string>
    } = {}
    const onPrepared = mock(() => {})

    const result = await createAnthropicMessages(createPayload(), {
      headersCapture,
      onPrepared,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      id: "msg_123",
      model: "claude-sonnet-4.6",
    })
    expect(headersCapture.request?.Authorization).toBe("Bearer copilot-test-token")
    expect(headersCapture.response?.["x-request-id"]).toBe("resp-1")
    expect(onPrepared).toHaveBeenCalledTimes(1)
  })

  test("returns an async iterable for streaming responses", async () => {
    setFetchMock(async () =>
      createSseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4.6","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        "data: [DONE]\n\n",
      ]),
    )

    const result = await createAnthropicMessages(createPayload({ stream: true }))
    const iterator = (result as AsyncIterable<ServerSentEventMessage>)[Symbol.asyncIterator]()
    const first = await iterator.next()

    expect(first.done).toBe(false)
    expect(first.value?.event).toBe("message_start")
  })

  test("throws HTTPError for failed upstream responses", async () => {
    setFetchMock(async () => new Response("bad gateway", { status: 502 }))

    await expect(createAnthropicMessages(createPayload())).rejects.toBeInstanceOf(HTTPError)
  })

  test("drives the upstream timeout from our application-level abort signal", async () => {
    // The upstream request now goes through undici (transport/upstream-fetch.ts),
    // which has no built-in timeout clock (unlike Bun's global fetch). So
    // `timeouts.response_header` stays the single source of truth, carried via the
    // abort signal on the request rather than a `timeout:false` flag.
    const fetchMock = setFetchMock(
      async () =>
        new Response(
          JSON.stringify({
            id: "msg_x",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4.6",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200 },
        ),
    )

    await createAnthropicMessages(createPayload())

    const init = fetchMock.mock.calls[0]?.[1] as { signal?: unknown } | undefined
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })
})

describe("anthropic client — shutdown interruption", () => {
  autoRestoreFetch()
  autoRestoreState()

  beforeEach(() => {
    setStateForTests({
      accountType: "individual",
      copilotToken: "copilot-test-token",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      contextEditingMode: "off",
    })
  })

  afterEach(() => {
    // gracefulShutdown mutates the shutdown module's abort controller; reset it
    // so the aborted signal does not leak into later tests in this process.
    _resetShutdownState()
  })

  test("non-streaming request interrupted by shutdown → retryable HTTP 529", async () => {
    // Upstream never resolves on its own; rejects with AbortError once the
    // request signal aborts (the non-streaming branch folds the shutdown signal
    // into the fetch signal).
    setFetchMock(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"))
          if (signal?.aborted) return onAbort()
          signal?.addEventListener("abort", onAbort, { once: true })
        }),
    )

    // Phase 1 (synchronous) installs the shutdown signal before createAnthropicMessages
    // reads it; Phase 3 fires the abort ~10ms later, aborting the in-flight fetch.
    const shutdownPromise = gracefulShutdown("SIGTERM", {
      tracker: createMockTracker([{ status: "streaming" }]),
      server: createMockServer(),
      rateLimiter: null,
      stopTokenRefreshFn: () => {},
      closeAllClientsFn: () => {},
      getClientCountFn: () => 0,
      contextManager: { stopReaper: () => {} },
      gracefulWaitMs: 50,
      abortWaitMs: 500,
      drainPollIntervalMs: 10,
      drainProgressIntervalMs: 50_000,
    })

    await expect(createAnthropicMessages(createPayload({ stream: false }))).rejects.toMatchObject({
      status: 529,
    })
    await shutdownPromise
  })
})

/**
 * The 529 rewrite gate is CAUSAL, not temporal. The reviewer's probe showed the old
 * `getShutdownSignal().aborted` form mislabelling a reaper cancel that merely landed inside
 * the drain window; these lock the fix so it cannot regress to a time-based test.
 *
 * Driven through `postAnthropicUpstream` — the function that owns the gate — with an explicit
 * signal, so each arm controls exactly which party cancelled.
 */
describe("postAnthropicUpstream — the 529 gate reads CAUSE, not the shutdown clock", () => {
  autoRestoreFetch()
  autoRestoreState()

  beforeEach(() => {
    setStateForTests({ accountType: "individual", copilotToken: "copilot-test-token", vsCodeVersion: "1.100.0", responseHeaderTimeout: 0 })
  })

  afterEach(() => {
    _resetShutdownState()
  })

  /** Open a real shutdown window and wait until Phase 3 has fired its abort. */
  async function enterShutdownWindow(): Promise<{ done: Promise<void>; reason: Error }> {
    const done = gracefulShutdown("SIGTERM", {
      // One never-finishing request: with an empty tracker the drain completes instantly and
      // shutdown skips Step 3 entirely, so the abort we need here would never fire.
      tracker: createMockTracker([{ status: "streaming" }]),
      server: createMockServer(),
      rateLimiter: null,
      stopTokenRefreshFn: () => {},
      closeAllClientsFn: () => {},
      getClientCountFn: () => 0,
      contextManager: { stopReaper: () => {} },
      gracefulWaitMs: 10,
      abortWaitMs: 200,
      drainPollIntervalMs: 5,
      drainProgressIntervalMs: 50_000,
    })
    while (!getShutdownSignal().aborted) await new Promise((r) => setTimeout(r, 5))
    return { done, reason: getShutdownSignal().reason as Error }
  }

  function post(signal: AbortSignal | undefined, thrown: Error): Promise<Response> {
    setFetchMock(() => Promise.reject(thrown))
    return postAnthropicUpstream({ path: "/v1/messages", wire: { model: "claude-sonnet-4.6" }, headers: {}, model: "claude-sonnet-4.6", signal })
  }

  test("a shutdown-caused abort → retryable 529 (positive control for the arms below)", async () => {
    const { done, reason } = await enterShutdownWindow()
    await expect(post(getShutdownSignal(), reason)).rejects.toMatchObject({ status: 529 })
    await done
  })

  test("a transport that synthesizes a FRESH AbortError still gets 529 when the signal reason is the shutdown one", async () => {
    // This is the real h2/undici shape: the transport does not surface `signal.reason`, it
    // throws its own AbortError. The second probe (`args.signal.reason`) is what catches it.
    const { done } = await enterShutdownWindow()
    const fresh = new DOMException("The operation was aborted.", "AbortError")
    await expect(post(getShutdownSignal(), fresh)).rejects.toMatchObject({ status: 529 })
    await done
  })

  test("a reaper cancel that merely LANDS inside the drain window is NOT relabelled as a shutdown", async () => {
    // The whole point: the shutdown signal IS aborted here, so a temporal gate answers 529 and
    // tells the client "Server is shutting down" about a request the stale reaper killed.
    const { done } = await enterShutdownWindow()
    const reaperSignal = AbortSignal.abort(cancellationAbortError("stale-reaper", "Request cancelled by the stale-request reaper"))
    const thrown = reaperSignal.reason as Error

    const error = await post(reaperSignal, thrown).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBe(thrown) // rethrown verbatim, not wrapped
    expect(error).not.toBeInstanceOf(HTTPError)
    expect((error as Error).message).not.toContain(SHUTDOWN_ABORT_MESSAGE)
    await done
  })

  test("a hard-deadline cancel inside the drain window is likewise left alone", async () => {
    const { done } = await enterShutdownWindow()
    const deadlineSignal = AbortSignal.abort(cancellationAbortError("request-deadline", "request_deadline"))
    const thrown = deadlineSignal.reason as Error

    await expect(post(deadlineSignal, thrown)).rejects.toBe(thrown)
    await done
  })
})
