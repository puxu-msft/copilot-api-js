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
import { Hono } from "hono"
import {
  //
  upgradeWebSocket,
  websocket,
} from "hono/bun"

import type {
  //
  ResponsesPayload,
  ResponsesResponse,
} from "~/types/api/openai-responses"

import { getHistory } from "~/lib/history"
import { gracefulShutdown } from "~/lib/shutdown"
import {
  //
  type StateSnapshot,
  restoreStateForTests,
  setModels,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"
import { closeAllClients } from "~/lib/ws"

import { mockModel } from "../helpers/factories"
import {
  //
  applyFetchMock,
  restoreFetch,
} from "../helpers/mock-fetch"
import { createMockServer } from "../helpers/mock-server"
import { createMockTracker } from "../helpers/mock-tracker"
import { createSseResponse } from "../helpers/sse"
import {
  //
  bootstrapTestRuntime,
  resetTestRuntime,
} from "../helpers/test-bootstrap"

let capturedPayload: ResponsesPayload | undefined
/** When true, the mock upstream emits a real event AFTER response.completed (to test the terminal-event break). */
let emitTrailingAfterCompleted = false
/** When true, the mock upstream emits output_item.added(id=A) + .done(id=B) so stream-id-sync (via the driver's S5 registry) corrects .done to A. */
let emitIdMismatch = false

const upstreamFetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
  if (typeof init?.body !== "string") {
    throw new TypeError(`expected string body in mock, got ${typeof init?.body}`)
  }
  capturedPayload = JSON.parse(init.body) as ResponsesPayload

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
  let snapshot: StateSnapshot
  let server: TestServerHandle | undefined

  beforeAll(() => {
    bootstrapTestRuntime()
  })

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    capturedPayload = undefined
    emitTrailingAfterCompleted = false
    emitIdMismatch = false
    upstreamFetchMock.mockClear()
    setStateForTests({
      accountType: "individual",
      copilotToken: "copilot-test-token",
      vsCodeVersion: "1.100.0",
      fetchTimeout: 0,
    })
    applyFetchMock(upstreamFetchMock)
  })

  afterEach(() => {
    restoreFetch()
    server?.stop()
    server = undefined
    closeAllClients()
    restoreStateForTests(snapshot)
    resetTestRuntime()
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

    server = startWsServer()
    const ws = new WebSocket(`${server.url}/responses`)
    await waitForOpen(ws)

    const messages: Array<Record<string, unknown>> = []
    ws.addEventListener("message", (event: MessageEvent) => {
      messages.push(JSON.parse(String(event.data)) as Record<string, unknown>)
    })

    ws.send(JSON.stringify({ type: "response.create", response: { model: "gpt-4o", input: "first" } }))

    // Wait for the response.completed frame to arrive
    for (let i = 0; i < 50; i++) {
      if (messages.some((m) => m.type === "response.completed")) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(messages.some((m) => m.type === "response.completed")).toBe(true)

    // Socket must still be OPEN — server did not close after completed
    expect(ws.readyState).toBe(WebSocket.OPEN)

    ws.close()
  })

  test("rejects messages exceeding maxWsFrameBytes with invalid_request_error", async () => {
    server = startWsServer()

    const ws = new WebSocket(`${server.url}/responses`)
    const closePromise = waitForSocketClose(ws)

    await waitForOpen(ws)
    // Build a 1 MiB + 1 byte payload — over the default 1 MiB cap
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
    await shutdownPromise
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
    const inboundToolTypes = (historyEntry?.inboundRequest?.tools ?? []).map((t) => (t as { type?: string }).type)
    expect(inboundToolTypes).toEqual(["function", "image_generation", "web_search"])
  })
})
