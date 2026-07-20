import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"
import { Hono } from "hono"
import {
  //
  upgradeWebSocket,
  websocket,
} from "hono/bun"

import type { RequestContext } from "~/lib/context/request"
import type {
  //
  ResponsesPayload,
  ResponsesResponse,
} from "~/types/api/openai-responses"

import { getRequestContextManager } from "~/lib/context/manager"
import { getHistory } from "~/lib/history"
import { gracefulShutdown } from "~/lib/shutdown"
import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"
import { StreamClientAbortError } from "~/lib/stream"
import { closeAllClients } from "~/lib/ws"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createMockServer } from "../helpers/mock-server"
import { createMockTracker } from "../helpers/mock-tracker"
import {
  //
  createSseResponse,
  createSseResponseThenError,
} from "../helpers/sse"

let capturedPayload: ResponsesPayload | undefined
/** When true, the mock upstream emits a real event AFTER response.completed (to test the terminal-event break). */
let emitTrailingAfterCompleted = false
/** When true, the mock upstream emits output_item.added(id=A) + .done(id=B) so stream-id-sync (via the driver's S5 registry) corrects .done to A. */
let emitIdMismatch = false
/** When true, the mock upstream emits created + a text delta then EOF — NO response.completed (truncation). */
let emitTruncated = false

const upstreamFetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
  if (typeof init?.body !== "string") {
    throw new TypeError(`expected string body in mock, got ${typeof init?.body}`)
  }
  capturedPayload = JSON.parse(init.body) as ResponsesPayload

  if (emitTruncated) {
    // created + a delta, then EOF — no terminal response event, no [DONE].
    return createSseResponse([
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: createBaseResponsesResponse(capturedPayload.model, "in_progress") })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hi", sequence_number: 1 })}\n\n`,
    ])
  }

  if (emitIdMismatch) {
    return createSseResponse([
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: createBaseResponsesResponse(capturedPayload.model, "in_progress") })}\n\n`,
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { id: "oi_canonical", type: "message", role: "assistant", status: "in_progress", content: [] } })}\n\n`,
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", sequence_number: 2, output_index: 0, item: { id: "oi_DIFFERENT", type: "message", role: "assistant", status: "completed", content: [] } })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 3, response: createBaseResponsesResponse(capturedPayload.model, "completed", { input_tokens: 1, output_tokens: 1, total_tokens: 2 }) })}\n\n`,
      "data: [DONE]\n\n",
    ])
  }

  const frames = [
    `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      sequence_number: 0,
      response: createBaseResponsesResponse(capturedPayload.model, "in_progress"),
    })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "Hello from WS",
      sequence_number: 1,
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      sequence_number: 2,
      response: createBaseResponsesResponse(capturedPayload.model, "completed", {
        input_tokens: 5,
        output_tokens: 3,
        total_tokens: 8,
      }),
    })}\n\n`,
  ]
  if (emitTrailingAfterCompleted) {
    frames.push(
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "TRAILING", sequence_number: 3 })}\n\n`,
    )
  }
  frames.push("data: [DONE]\n\n")
  return createSseResponse(frames)
})

function createBaseResponsesResponse(model: string, status: ResponsesResponse["status"], usage: ResponsesResponse["usage"] = null): ResponsesResponse {
  return {
    id: "resp-ws-test",
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

interface SocketCloseResult {
  code: number
  messages: Array<Record<string, unknown>>
  reason: string
}

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

function waitForSocketClose(ws: WebSocket, timeoutMs = 3000): Promise<SocketCloseResult> {
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
      resolve({
        code: event.code,
        messages,
        reason: event.reason,
      })
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

describe("Responses WebSocket transport", () => {
  useIsolatedRuntime()

  let server: TestServerHandle | undefined

  beforeEach(() => {
    capturedPayload = undefined
    emitTrailingAfterCompleted = false
    emitIdMismatch = false
    emitTruncated = false
    upstreamFetchMock.mockClear()
    setStateForTests({
      accountType: "individual",
      copilotToken: "copilot-test-token",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
    })
    applyFetchMock(upstreamFetchMock)
  })

  afterEach(() => {
    server?.stop()
    server = undefined
    closeAllClients()
  })

  test("sends an invalid_request_error frame for malformed JSON messages", async () => {
    server = startWsServer()

    const ws = new WebSocket(`${server.url}/responses`)
    const closePromise = waitForSocketClose(ws)

    await waitForOpen(ws)
    ws.send("{ invalid json")

    const result = await closePromise

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Invalid JSON message",
      },
    })
    expect(result.code).toBe(1011)
    expect(upstreamFetchMock).not.toHaveBeenCalled()
  })

  test("upgrades, forwards streamed response frames, and closes cleanly", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })

    server = startWsServer()

    const ws = new WebSocket(`${server.url}/responses`)
    const closePromise = waitForSocketClose(ws)

    await waitForOpen(ws)
    ws.send(
      JSON.stringify({
        type: "response.create",
        response: {
          model: "gpt-4o",
          input: "Hello from WS client",
        },
      }),
    )

    const result = await closePromise

    expect(result.messages.map((message) => message.type)).toEqual(["response.created", "response.output_text.delta", "response.completed"])
    expect(result.messages[1]?.delta).toBe("Hello from WS")
    expect(result.code).toBe(1000)
    expect(result.reason).toBe("done")
    expect(upstreamFetchMock).toHaveBeenCalledTimes(1)
    expect(capturedPayload?.model).toBe("gpt-4o")
    expect(capturedPayload?.input).toBe("Hello from WS client")
    expect(capturedPayload?.stream).toBe(true)
  })

  test("stream-id-sync over WS: .done id corrected to .added id (shared S5 registry)", async () => {
    // Proves the A.C migration: fix-stream-ids now lives in the driver's S5 response-rewrite
    // registry, so the WS transport gets it from the SAME registry the HTTP path uses — no
    // per-transport inline idTracker. With fixResponsesStreamIds on, the mismatched .done id
    // (oi_DIFFERENT) must be rewritten to the canonical .added id (oi_canonical).
    setModels({ object: "list", data: [mockModel("gpt-4o", { vendor: "OpenAI", supported_endpoints: ["/chat/completions", "/responses"] })] })
    setStateForTests({ fixResponsesStreamIds: true })
    emitIdMismatch = true

    server = startWsServer()
    const ws = new WebSocket(`${server.url}/responses`)
    const closePromise = waitForSocketClose(ws)
    await waitForOpen(ws)
    ws.send(JSON.stringify({ type: "response.create", response: { model: "gpt-4o", input: "hi" } }))

    const result = await closePromise

    const doneFrame = result.messages.find((m) => m.type === "response.output_item.done") as { item?: { id?: string } } | undefined
    expect(doneFrame?.item?.id).toBe("oi_canonical")
    expect(JSON.stringify(result.messages)).not.toContain("oi_DIFFERENT")
    expect(result.code).toBe(1000)
  })

  test("stops at the terminal event — a frame after response.completed is not forwarded", async () => {
    setModels({
      object: "list",
      data: [mockModel("gpt-4o", { vendor: "OpenAI", supported_endpoints: ["/chat/completions", "/responses"] })],
    })
    emitTrailingAfterCompleted = true
    // Explicit-false: this test exercises the LIVE path's `stopAfterFrame` terminal early-stop —
    // `runResponseBufferedSink` never reads `stopAfterFrame` (driver.ts:577 is the only reference,
    // in `runResponseSink`; see docs/todo/deferred-backlog.md's "structurally MOOT" note), so under
    // the new default-true buffered WS path (2026-07-14 P4 flip) this trailing frame would simply
    // never get committed rather than being read-then-dropped. Force live so this test still
    // exercises the early-stop mechanism it means to test.
    setStateForTests({ responsesBufferedRetry: false })

    server = startWsServer()
    const ws = new WebSocket(`${server.url}/responses`)
    const closePromise = waitForSocketClose(ws)
    await waitForOpen(ws)
    ws.send(JSON.stringify({ type: "response.create", response: { model: "gpt-4o", input: "hi" } }))

    const result = await closePromise

    // The trailing delta after response.completed must NOT reach the client.
    expect(result.messages.map((m) => m.type)).toEqual(["response.created", "response.output_text.delta", "response.completed"])
    expect(JSON.stringify(result.messages)).not.toContain("TRAILING")
    expect(result.code).toBe(1000)
  })

  test("truncated upstream (no response.completed) → error frame + 1011 close, history FAILED", async () => {
    setModels({
      object: "list",
      data: [mockModel("gpt-4o", { vendor: "OpenAI", supported_endpoints: ["/chat/completions", "/responses"] })],
    })
    emitTruncated = true

    // HIGH-1: the WS clean-EOF truncation also emits the rich diagnostic (kind=truncated).
    const diagSpy = spyOn(consola, "error").mockImplementation(Object.assign(() => {}, { raw: () => {} }))
    server = startWsServer()
    const ws = new WebSocket(`${server.url}/responses`)
    const closePromise = waitForSocketClose(ws)
    await waitForOpen(ws)
    ws.send(JSON.stringify({ type: "response.create", response: { model: "gpt-4o", input: "hi" } }))

    const result = await closePromise

    const diagLine = diagSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("[upstream-diagnostics] STREAM DISCONNECT"))
    diagSpy.mockRestore()
    expect(diagLine).toBeDefined()
    expect(diagLine).toContain("kind=truncated")
    expect(diagLine).not.toContain("frames=0")
    expect(diagLine).toContain("last-frame=response.output_text.delta@")

    // A clean terminator: an error frame + the WS H3 close code (1011), not a silent 1000.
    const errorFrame = result.messages.find((m) => m.type === "error") as { error?: { message?: string } } | undefined
    expect(errorFrame).toBeDefined()
    expect(String(errorFrame?.error?.message)).toContain("truncated")
    expect(result.code).toBe(1011)

    const entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    expect(entry?.state).toBe("failed")
    expect(String(entry?._index?.derived?.failureReason)).toContain("truncated")
    // The error frame the client received (via sendErrorAndClose) is recorded in the forwarded
    // (proxy→client) track — asserts the WS sendErrorAndClose→recordForwarded→fail ordering.
    const errRecord = (entry?.clientResponse?.sseEvents ?? []).find((e) => e.raw.includes('"error"'))
    expect(errRecord).toBeDefined()
    // Cross-model review Major (producer-oracle): the POST-COMMIT terminal `event: error` frame
    // (this is the WS H3-analog terminus `sendErrorAndClose` sends, REPLACING the upstream
    // terminator) must carry `synthetic:"error-shaping-canonical"` on the RECORD itself — the 3rd
    // `syntheticKind` param passed to `captureForwardedGenerationFrame` only drives arena
    // origin/transformId, not what projection.ts's `frames()` reads back (`node.value.synthetic`).
    // Independent oracle: reads the SAME persisted history entry a real request populates.
    expect(errRecord?.synthetic).toBe("error-shaping-canonical")
  })

  test("keeps socket open after response.completed when clientWebsocketKeepOpen is true", async () => {
    setStateForTests({ clientWebsocketKeepOpen: true })
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })

    const capturedContexts: Array<RequestContext> = []
    const manager = getRequestContextManager()
    const originalCreate = manager.create.bind(manager)
    manager.create = (opts) => {
      const ctx = originalCreate(opts)
      capturedContexts.push(ctx)
      return ctx
    }

    server = startWsServer()
    const ws = new WebSocket(`${server.url}/responses`)
    await waitForOpen(ws)

    const messages: Array<Record<string, unknown>> = []
    ws.addEventListener("message", (event: MessageEvent) => {
      messages.push(JSON.parse(String(event.data)) as Record<string, unknown>)
    })

    ws.send(
      JSON.stringify({ type: "response.create", response: { id: "client-create-1", model: "gpt-4o", input: "first", previous_response_id: "prev-raw-1" } }),
    )

    // Wait for the response.completed frame to arrive
    for (let i = 0; i < 50; i++) {
      if (messages.some((m) => m.type === "response.completed")) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(messages.some((m) => m.type === "response.completed")).toBe(true)

    // Socket must still be OPEN — server did not close after completed. Send a second independent
    // operation on the same connection; omit its id so the server generates a stable identifier.
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.send(JSON.stringify({ type: "response.create", response: { model: "gpt-4o", input: "second", previous_response_id: null } }))
    for (let i = 0; i < 50; i++) {
      if (messages.filter((m) => m.type === "response.completed").length >= 2) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(messages.filter((m) => m.type === "response.completed")).toHaveLength(2)
    expect(capturedContexts).toHaveLength(2)
    const firstIdentity = capturedContexts[0].modelOperationTerminalRecord?.identity
    const secondIdentity = capturedContexts[1].modelOperationTerminalRecord?.identity
    expect(firstIdentity).toMatchObject({ kind: "responses_ws", responseCreateId: "client-create-1", previousResponseId: "prev-raw-1" })
    expect(secondIdentity).toMatchObject({ kind: "responses_ws", previousResponseId: null })
    expect(firstIdentity?.connectionId).toBeTruthy()
    expect(secondIdentity?.connectionId).toBe(firstIdentity?.connectionId)
    expect(secondIdentity?.responseCreateId).toBeTruthy()
    expect(secondIdentity?.responseCreateId).not.toBe(firstIdentity?.responseCreateId)

    ws.close()
  })

  test("rejects messages exceeding a configured maxWsFrameBytes with invalid_request_error", async () => {
    // The cap is opt-in (default 0 = unlimited); set an explicit positive cap.
    setStateForTests({ maxWsFrameBytes: 1024 * 1024 })
    server = startWsServer()

    const ws = new WebSocket(`${server.url}/responses`)
    const closePromise = waitForSocketClose(ws)

    await waitForOpen(ws)
    // Build a 1 MiB + 1 byte payload — over the configured 1 MiB cap
    const huge = "x".repeat(1024 * 1024 + 1)
    ws.send(huge)

    const result = await closePromise

    expect(result.messages).toHaveLength(1)
    expect((result.messages[0] as { error: { type: string; message: string } }).error.type).toBe("invalid_request_error")
    expect((result.messages[0] as { error: { message: string } }).error.message).toContain("byte limit")
    expect(result.code).toBe(1011)
    expect(upstreamFetchMock).not.toHaveBeenCalled()
  })

  test("custom maxWsFrameBytes is honored by the cap check", async () => {
    setStateForTests({ maxWsFrameBytes: 64 })
    server = startWsServer()

    const ws = new WebSocket(`${server.url}/responses`)
    const closePromise = waitForSocketClose(ws)

    await waitForOpen(ws)
    // 65 bytes — over the configured 64-byte cap
    ws.send("x".repeat(65))

    const result = await closePromise
    expect((result.messages[0] as { error: { message: string } }).error.message).toContain("64 byte limit")
  })

  test("mid-stream shutdown sends a retryable error frame and closes with 1011", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })

    // Upstream emits response.created then STALLS forever (no more events). The
    // forwarding loop parks on the next read BEFORE shutdown begins — the genuine
    // "case b" scenario. With the stable shutdown signal, the Phase 3 abort still
    // wakes the already-blocked read.
    const hangingUpstream = mock((_input: string | URL | Request, init?: RequestInit) => {
      capturedPayload = typeof init?.body === "string" ? (JSON.parse(init.body) as ResponsesPayload) : undefined
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: response.created\ndata: ${JSON.stringify({
                type: "response.created",
                sequence_number: 0,
                response: createBaseResponsesResponse("gpt-4o", "in_progress"),
              })}\n\n`,
            ),
          )
          // Leave the body open forever — only the shutdown abort can end it.
        },
      })
      return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }))
    })
    applyFetchMock(hangingUpstream)

    server = startWsServer()
    const ws = new WebSocket(`${server.url}/responses`)
    const closePromise = waitForSocketClose(ws)

    await waitForOpen(ws)
    ws.send(JSON.stringify({ type: "response.create", response: { model: "gpt-4o", input: "stream please" } }))

    // Wait until the first frame is forwarded and the loop has PARKED on the
    // stalled read — establishing the case-b precondition before shutdown starts.
    await new Promise((r) => setTimeout(r, 60))

    // The WS leg must ALSO emit the [upstream-diagnostics] disconnect line with REAL signals (this leg
    // previously emitted none). response.created arrived before the shutdown abort → frames>0, honest last-frame.
    const diagSpy = spyOn(consola, "error").mockImplementation(Object.assign(() => {}, { raw: () => {} }))

    // Fire Phase 3 abort via a fast-timing graceful shutdown (mock tracker keeps
    // one "active" request so Phase 2 → Phase 3 transition runs).
    const shutdownPromise = gracefulShutdown("SIGTERM", {
      tracker: createMockTracker([{ status: "streaming" }]),
      server: createMockServer(),
      rateLimiter: null,
      stopTokenRefreshFn: () => {},
      closeAllClientsFn: () => {},
      getClientCountFn: () => 0,
      gracefulWaitMs: 40,
      abortWaitMs: 500,
      drainPollIntervalMs: 10,
      drainProgressIntervalMs: 50_000,
    })

    const result = await closePromise

    // The shutdown abort surfaced as a retryable server_error frame (not a fake
    // 1000 "done" close) so the client can back off and retry.
    const errorFrame = result.messages.find((m) => m.type === "error") as { error: { type: string; message: string } } | undefined
    expect(errorFrame?.error.type).toBe("server_error")
    expect(result.code).toBe(1011)
    const diagLine = diagSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("[upstream-diagnostics] STREAM DISCONNECT"))
    diagSpy.mockRestore()
    expect(diagLine).toBeDefined()
    expect(diagLine).toContain("model=gpt-4o")
    expect(diagLine).not.toContain("frames=0")
    expect(diagLine).toContain("last-frame=response.created@")
    await shutdownPromise
  })

  test("mid-stream client-abort → history aborted, no error frame, socket left OPEN (unlike H3/shutdown 1011)", async () => {
    setModels({ object: "list", data: [mockModel("gpt-resp", { vendor: "OpenAI", supported_endpoints: ["/responses"] })] })
    // Forward response.created, then the upstream read surfaces a client-abort. guardSseIterable
    // re-throws a source rejection unchanged (stream.ts next() catch → `throw error`), so the driver
    // classifies `client-abort` → `settled-abort`, exercising the WS handler's settled-abort branch
    // (ctx.abort + ZERO further bytes + NO ws.close).
    //
    // The abort is injected at the TRANSPORT BOUNDARY because the full client-INITIATED path (a real
    // mid-stream `ws.close()` → onClose → `wsClientAborts.abort()` → signal) does not propagate to the
    // server's onClose in the bare-Hono + `Bun.serve` test harness (verified: the request stays
    // `executing`). The onClose→abort glue is a ~2-line correct-by-inspection wiring; what this test
    // uniquely LOCKS is the WS-specific terminal DIVERGENCE — settled-abort leaves the socket OPEN and
    // sends no frame, whereas every other WS terminal (H3/shutdown/truncation) closes with 1011.
    const created = `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      sequence_number: 0,
      response: createBaseResponsesResponse("gpt-resp", "in_progress"),
    })}\n\n`
    applyFetchMock(mock(() => Promise.resolve(createSseResponseThenError([created], new StreamClientAbortError()))))

    server = startWsServer()
    const ws = new WebSocket(`${server.url}/responses`)
    const messages: Array<Record<string, unknown>> = []
    let closeCode: number | undefined
    ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data)) as Record<string, unknown>))
    ws.addEventListener("close", (event) => (closeCode = event.code))
    await waitForOpen(ws)
    ws.send(JSON.stringify({ type: "response.create", response: { model: "gpt-resp", input: "hi" } }))

    // settled-abort returns WITHOUT closing the socket, so there is no close event to await — poll the
    // history entry to its terminal state instead (mirrors the HTTP client-abort assertion).
    let entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    for (let i = 0; i < 200 && entry?.state !== "aborted"; i++) {
      await new Promise((r) => setTimeout(r, 10))
      entry = getHistory({ endpoint: "openai-responses", limit: 5 }).entries[0]
    }

    expect(entry?.state).toBe("aborted")
    // settled-abort sends NO error frame (it writes nothing further) and does NOT close the socket —
    // the WS-specific divergence from H3/shutdown/truncation, which all close with 1011.
    expect(messages.some((m) => m.type === "error")).toBe(false)
    expect(closeCode).toBeUndefined()
    ws.close()
  })

  test("rejects new connections beyond maxClientWsConnections", async () => {
    setStateForTests({ maxClientWsConnections: 1 })
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })

    server = startWsServer()

    const first = new WebSocket(`${server.url}/responses`)
    await waitForOpen(first)

    // Second connection must be rejected with code 1013 (Try Again Later).
    const second = new WebSocket(`${server.url}/responses`)
    const secondClose = waitForSocketClose(second)
    const result = await secondClose

    expect(result.code).toBe(1013)
    expect(result.messages).toHaveLength(1)
    expect((result.messages[0] as { error: { type: string } }).error.type).toBe("server_overloaded")

    first.close()
  })

  test("strip_image_generation_tool: drops image_generation from wire payload but keeps it in history.inboundRequest", async () => {
    // Regression for the merge of PR #4 (strip_image_generation_tool). Parity
    // with the HTTP handler — strip must run AFTER the history snapshot so
    // history retains evidence the client originally sent image_generation.
    // See CLAUDE.md 原则7: History 系统应记录请求/响应生命周期中所有可观测的原始数据.
    setStateForTests({ stripImageGenerationTool: true })
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          supported_endpoints: ["/chat/completions", "/responses"],
        }),
      ],
    })

    server = startWsServer()

    const ws = new WebSocket(`${server.url}/responses`)
    const closePromise = waitForSocketClose(ws)

    await waitForOpen(ws)
    ws.send(
      JSON.stringify({
        type: "response.create",
        response: {
          model: "gpt-4o",
          input: "Hello",
          tools: [{ type: "function", name: "lookup_weather" }, { type: "image_generation" }, { type: "web_search" }],
        },
      }),
    )

    await closePromise

    // Wire payload sent upstream: image_generation stripped, others preserved.
    const wireToolTypes = (capturedPayload?.tools ?? []).map((t) => (t as { type?: string }).type)
    expect(wireToolTypes).toEqual(["function", "web_search"])

    // History inboundRequest: client's original tools array intact.
    const historyEntry = getHistory({ endpoint: "openai-responses" }).entries[0]
    const inboundToolTypes = (historyEntry?.clientRequest?.tools ?? []).map((t) => (t as { type?: string }).type)
    expect(inboundToolTypes).toEqual(["function", "image_generation", "web_search"])
  })
})
