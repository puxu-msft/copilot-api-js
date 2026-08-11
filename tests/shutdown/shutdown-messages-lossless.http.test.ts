import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getRequestContextManager } from "~/lib/context/manager"
import { getHistory } from "~/lib/history/store"
import { setModels } from "~/lib/models/cache"
import {
  //
  getShutdownPhase,
  gracefulShutdown,
} from "~/lib/shutdown"
import { setStateForTests } from "~/lib/state"
import {
  //
  installTokenRuntime,
  type TokenRuntime,
} from "~/lib/token"

import {
  //
  DONE_FRAME,
  MESSAGE_STOP_FRAME,
  blockStopFrame,
  messageDeltaFrame,
  messageStartFrame,
  textBlockStartFrame,
  textDeltaFrame,
} from "../helpers/anthropic-frames"
import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { frameTypesInOrder } from "../helpers/sse"
import { createFullTestApp } from "../helpers/test-app"
import { waitUntil } from "../helpers/wait-until"

const MODEL = "claude-opus-4.8"
const app = createFullTestApp()

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function completeFrames(text: string): Array<string> {
  return [
    messageStartFrame({ id: "msg_shutdown", model: MODEL }),
    textBlockStartFrame(0),
    textDeltaFrame(0, text),
    blockStopFrame(0),
    messageDeltaFrame({ stopReason: "end_turn", outputTokens: 3 }),
    MESSAGE_STOP_FRAME,
    DONE_FRAME,
  ]
}

function controlledSseResponse(input: {
  readonly prefix: Array<string>
  readonly release: Promise<void>
  readonly suffix?: Array<string>
  readonly started: Deferred
}): Response {
  const encoder = new TextEncoder()
  let phase = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (phase === 0) {
        phase = 1
        for (const frame of input.prefix) controller.enqueue(encoder.encode(frame))
        input.started.resolve()
        return
      }
      if (phase === 1) {
        phase = 2
        return input.release.then(() => {
          for (const frame of input.suffix ?? []) controller.enqueue(encoder.encode(frame))
          controller.close()
        })
      }
    },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}

async function request(sessionId: string): Promise<Response> {
  return await app.request("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "finish during drain" }],
      max_tokens: 256,
      stream: true,
    }),
  })
}

function startShutdown(closeOrder: Array<string>): Promise<void> {
  return gracefulShutdown("SIGTERM", {
    server: { close: async () => {} },
    closeTokenRuntimeFn: async () => void closeOrder.push("token"),
    closeAllClientsFn: () => {},
    getClientCountFn: () => 0,
    contextManager: { stopReaper: () => {} },
    shutdownHistoryFn: async () => void closeOrder.push("history"),
    shutdownRequestTelemetryFn: async () => void closeOrder.push("telemetry"),
    shutdownDiagnosticLoggingFn: async () => void closeOrder.push("diagnostic"),
    drainPollIntervalMs: 1,
    drainProgressIntervalMs: 50_000,
  })
}

async function readStreamingResponse(sessionId: string): Promise<{ response: Response; body: Promise<string> }> {
  const response = await request(sessionId)
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  return { response, body: response.text() }
}

describe("lossless shutdown across real Anthropic generation paths", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      staleRequestMaxAge: 0,
      streamKeepalivePingSec: 0,
      preContentRecovery: { enabled: true },
      protectStreamingGeneration: false,
    })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  test("an accepted streaming request completes normally before shutdown closes request dependencies", async () => {
    const release = deferred()
    const started = deferred()
    applyFetchMock(
      mock(async () =>
        controlledSseResponse({
          prefix: [messageStartFrame({ id: "msg_shutdown", model: MODEL }), textBlockStartFrame(0), textDeltaFrame(0, "before shutdown")],
          release: release.promise,
          suffix: [
            textDeltaFrame(0, " after shutdown"),
            blockStopFrame(0),
            messageDeltaFrame({ stopReason: "end_turn", outputTokens: 4 }),
            MESSAGE_STOP_FRAME,
            DONE_FRAME,
          ],
          started,
        }),
      ),
    )

    const sessionId = "shutdown-live-stream"
    const streaming = await readStreamingResponse(sessionId)
    await started.promise
    await waitUntil(() => getRequestContextManager().getTrackedOperations().length === 1, { label: "streaming operation to enter production drain registry" })

    const closeOrder: Array<string> = []
    const shutdown = startShutdown(closeOrder)
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(getShutdownPhase()).toBe("draining")
      expect(closeOrder).toEqual([])
    } finally {
      release.resolve()
    }
    const sse = await streaming.body
    await shutdown

    expect(frameTypesInOrder(sse)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(frameTypesInOrder(sse)).not.toContain("error")
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    expect(String(entry?._index?.derived?.failureReason ?? "")).not.toContain("shutting down")
    expect(closeOrder).toEqual(["token", "history", "telemetry", "diagnostic"])
  })

  test("a token-refresh retry completes while shutdown keeps the installed runtime alive", async () => {
    const refreshStarted = deferred()
    const releaseRefresh = deferred()
    const runtimeEvents: Array<string> = []
    installTokenRuntime({
      refreshCopilotToken: async () => {
        runtimeEvents.push("refresh-start")
        refreshStarted.resolve()
        await releaseRefresh.promise
        runtimeEvents.push("refresh-complete")
        return true
      },
      dispose: async () => void runtimeEvents.push("token-dispose"),
    } as unknown as TokenRuntime)

    let upstreamCalls = 0
    applyFetchMock(
      mock(async () => {
        upstreamCalls += 1
        if (upstreamCalls === 1) {
          return new Response(JSON.stringify({ error: { message: "token expired" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          })
        }
        return new Response(
          JSON.stringify({
            id: "msg_shutdown_refresh",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "refreshed during drain" }],
            model: MODEL,
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }),
    )

    const sessionId = "shutdown-token-refresh"
    const responsePromise = app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "refresh then finish" }],
        max_tokens: 64,
        stream: false,
      }),
    })
    await refreshStarted.promise
    expect(getRequestContextManager().getTrackedOperations()).toHaveLength(1)

    const closeOrder: Array<string> = []
    const shutdown = gracefulShutdown("SIGTERM", {
      server: { close: async () => {} },
      closeAllClientsFn: () => {},
      getClientCountFn: () => 0,
      contextManager: { stopReaper: () => {} },
      shutdownHistoryFn: async () => void closeOrder.push("history"),
      shutdownRequestTelemetryFn: async () => void closeOrder.push("telemetry"),
      shutdownDiagnosticLoggingFn: async () => void closeOrder.push("diagnostic"),
      drainPollIntervalMs: 1,
      drainProgressIntervalMs: 50_000,
    })
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(getShutdownPhase()).toBe("draining")
      expect(runtimeEvents).toEqual(["refresh-start"])
      expect(closeOrder).toEqual([])
    } finally {
      releaseRefresh.resolve()
    }

    const response = await responsePromise
    expect(response.status).toBe(200)
    await shutdown

    expect(upstreamCalls).toBe(2)
    expect(runtimeEvents).toEqual(["refresh-start", "refresh-complete", "token-dispose"])
    expect(closeOrder).toEqual(["history", "telemetry", "diagnostic"])
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    expect(entry?._index?.derived?.attemptCount).toBe(2)
  })

  test("pre-content recovery starts a fresh upstream exchange while shutdown is draining", async () => {
    const releasePrimaryFailure = deferred()
    const primaryStarted = deferred()
    const releaseRecovery = deferred()
    const recoveryStarted = deferred()
    let upstreamCalls = 0
    applyFetchMock(
      mock(async () => {
        upstreamCalls += 1
        if (upstreamCalls === 1) {
          return controlledSseResponse({
            prefix: [messageStartFrame({ id: "msg_shutdown_primary", model: MODEL })],
            release: releasePrimaryFailure.promise,
            started: primaryStarted,
          })
        }
        return controlledSseResponse({
          prefix: completeFrames("recovered during drain").slice(0, 3),
          release: releaseRecovery.promise,
          suffix: completeFrames("recovered during drain").slice(3),
          started: recoveryStarted,
        })
      }),
    )

    const sessionId = "shutdown-precontent-recovery"
    const streaming = await readStreamingResponse(sessionId)
    await primaryStarted.promise
    await waitUntil(() => getRequestContextManager().getTrackedOperations().length === 1, { label: "recoverable operation to enter production drain registry" })

    const closeOrder: Array<string> = []
    const shutdown = startShutdown(closeOrder)
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(getShutdownPhase()).toBe("draining")
      releasePrimaryFailure.resolve()
      const recoveryOrEarlyTerminal = await Promise.race([
        recoveryStarted.promise.then(() => ({ kind: "recovery" as const })),
        streaming.body.then((body) => ({ kind: "early-terminal" as const, body })),
      ])
      expect(recoveryOrEarlyTerminal).toEqual({ kind: "recovery" })
      expect(upstreamCalls).toBe(2)
      expect(closeOrder).toEqual([])
    } finally {
      releasePrimaryFailure.resolve()
      releaseRecovery.resolve()
    }
    const sse = await streaming.body
    await shutdown

    expect(frameTypesInOrder(sse)).toContain("message_stop")
    expect(frameTypesInOrder(sse)).not.toContain("error")
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    expect(entry?._index?.derived?.attemptCount).toBe(2)
    expect(entry?.attempts?.map((attempt) => attempt.candidateRole)).toEqual(["primary", "recovery"])
    expect(closeOrder).toEqual(["token", "history", "telemetry", "diagnostic"])
  })
})
