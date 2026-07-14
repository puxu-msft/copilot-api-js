/**
 * C0 golden pre-capture (c-ws) — Responses WebSocket transport TERMINAL byte golden.
 *
 * A WS client (`response.create` over the `/responses` WS transport) receives the upstream Responses SSE
 * forwarded as WS JSON messages, terminating at `response.completed` with a clean 1000/"done" close. The
 * existing `responses-ws.http.test.ts` locks the message TYPES + one delta; this locks the FULL forwarded
 * message objects byte-for-byte (esp. the terminal `response.completed` frame) — the terminal-frame path
 * C4 touches when the Responses cell assembly migrates.
 *
 * Real Bun.serve on an EPHEMERAL port (port 0, NOT 4141); stopped in afterEach.
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

import type {
  //
  ResponsesPayload,
  ResponsesResponse,
} from "~/types/api/openai-responses"

import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"

let capturedPayload: ResponsesPayload | undefined

function baseResponse(model: string, status: ResponsesResponse["status"], usage: ResponsesResponse["usage"] = null): ResponsesResponse {
  return {
    id: "resp-c0ws",
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

const upstreamFetchMock = mock((_input: string | URL | Request, init?: RequestInit) => {
  if (typeof init?.body !== "string") throw new TypeError("expected string body in mock")
  capturedPayload = JSON.parse(init.body) as ResponsesPayload
  return Promise.resolve(
    createSseResponse([
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: baseResponse(capturedPayload.model, "in_progress") })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello WS", sequence_number: 1 })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 2, response: baseResponse(capturedPayload.model, "completed", { input_tokens: 5, output_tokens: 3, total_tokens: 8 }) })}\n\n`,
      "data: [DONE]\n\n",
    ]),
  )
})

const { registerWsRoutes } = await import("~/routes")

function startWsServer(): { url: string; stop: () => void } {
  const app = new Hono()
  registerWsRoutes(app, upgradeWebSocket)
  const server = Bun.serve({ port: 0, fetch: (request, bunServer) => app.fetch(request, { server: bunServer }), websocket })
  return { url: `ws://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true })
  })
}

interface CloseResult {
  code: number
  reason: string
  messages: Array<Record<string, unknown>>
  raw: Array<string>
}

function waitForClose(ws: WebSocket, timeoutMs = 3000): Promise<CloseResult> {
  return new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = []
    const raw: Array<string> = []
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for WS close after ${timeoutMs}ms`))
    }, timeoutMs)
    const onMessage = (event: MessageEvent) => {
      raw.push(String(event.data))
      messages.push(JSON.parse(String(event.data)) as Record<string, unknown>)
    }
    const onClose = (event: CloseEvent) => {
      cleanup()
      resolve({ code: event.code, reason: event.reason, messages, raw })
    }
    const cleanup = () => {
      clearTimeout(timeout)
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("close", onClose)
    }
    ws.addEventListener("message", onMessage)
    ws.addEventListener("close", onClose, { once: true })
  })
}

describe("C0 golden (c-ws) — Responses WS terminal forwarded messages (byte-for-byte)", () => {
  useIsolatedRuntime()
  let server: { url: string; stop: () => void } | undefined

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    capturedPayload = undefined
    applyFetchMock(upstreamFetchMock)
    setStateForTests({ copilotToken: "tok" })
    setModels({ object: "list", data: [] })
  })

  afterEach(() => {
    server?.stop()
    server = undefined
  })

  test("response.create → forwarded WS messages are byte-locked, closes 1000/done", async () => {
    setModels({ object: "list", data: [mockModel("gpt-4o", { vendor: "OpenAI", supported_endpoints: ["/chat/completions", "/responses"] })] })

    server = startWsServer()
    const ws = new WebSocket(`${server.url}/responses`)
    const closeP = waitForClose(ws)
    await waitForOpen(ws)
    ws.send(JSON.stringify({ type: "response.create", response: { model: "gpt-4o", input: "hi WS" } }))
    const result = await closeP

    // ── BYTE GOLDEN: the exact forwarded WS message objects (parsed, deep-equal) ─────────────────────────
    // created → text delta → completed, then a clean 1000/"done" close. The trailing `[DONE]` sentinel is
    // NOT forwarded as a message (the pump stops at the terminal response event).
    expect(result.messages).toEqual([
      { type: "response.created", sequence_number: 0, response: baseResponse("gpt-4o", "in_progress") },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello WS", sequence_number: 1 },
      { type: "response.completed", sequence_number: 2, response: baseResponse("gpt-4o", "completed", { input_tokens: 5, output_tokens: 3, total_tokens: 8 }) },
    ])
    expect(result.code).toBe(1000)
    expect(result.reason).toBe("done")
    // No stray [DONE] message reached the client.
    expect(result.raw.some((r) => r.includes("[DONE]"))).toBe(false)
  })
})
