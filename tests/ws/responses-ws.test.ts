import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"

import { Hono } from "hono"
import { upgradeWebSocket, websocket } from "hono/bun"

import type { ResponsesPayload, ResponsesResponse } from "~/types/api/openai-responses"

import { closeAllClients } from "~/lib/history"
import { type StateSnapshot, restoreStateForTests, setModels, setStateForTests, snapshotStateForTests } from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { bootstrapTestRuntime, resetTestRuntime } from "../helpers/test-bootstrap"

let capturedPayload: ResponsesPayload | undefined
const originalFetch = globalThis.fetch

function createSseResponse(chunks: Array<string>) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

const upstreamFetchMock = mock(async (_input: string | URL | Request, init?: RequestInit) => {
  capturedPayload = JSON.parse(String(init?.body)) as ResponsesPayload

  return createSseResponse([
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
    "data: [DONE]\n\n",
  ])
})

function createBaseResponsesResponse(
  model: string,
  status: ResponsesResponse["status"],
  usage: ResponsesResponse["usage"] = null,
): ResponsesResponse {
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
    upstreamFetchMock.mockClear()
    setStateForTests({
      accountType: "individual",
      copilotToken: "copilot-test-token",
      vsCodeVersion: "1.100.0",
      fetchTimeout: 0,
    })
    globalThis.fetch = upstreamFetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
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

    expect(result.messages.map((message) => message.type)).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.completed",
    ])
    expect(result.messages[1]?.delta).toBe("Hello from WS")
    expect(result.code).toBe(1000)
    expect(result.reason).toBe("done")
    expect(upstreamFetchMock).toHaveBeenCalledTimes(1)
    expect(capturedPayload?.model).toBe("gpt-4o")
    expect(capturedPayload?.input).toBe("Hello from WS client")
    expect(capturedPayload?.stream).toBe(true)
  })
})
