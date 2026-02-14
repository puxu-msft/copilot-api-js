/**
 * Integration tests for history WebSocket notifications.
 *
 * Verifies the real data flow: store operations (recordRequest, recordResponse,
 * recordRewrites) trigger WebSocket broadcasts to connected clients.
 *
 * Uses mock WebSocket clients to capture broadcast messages without needing
 * a real HTTP server or WebSocket upgrade.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { RecordRequestParams, RecordResponseParams, RewriteInfo, WSMessage } from "~/lib/history"

import {
  addClient,
  clearHistory,
  closeAllClients,
  getClientCount,
  initHistory,
  recordRequest,
  recordResponse,
  recordRewrites,
} from "~/lib/history"

// ─── Helpers ───

function createMockWebSocket(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: mock(() => {}),
    close: mock(() => {}),
    addEventListener: mock(() => {}),
    removeEventListener: mock(() => {}),
    dispatchEvent: mock(() => false),
    binaryType: "blob" as "blob" | "arraybuffer",
    bufferedAmount: 0,
    extensions: "",
    onclose: null,
    onerror: null,
    onmessage: null,
    onopen: null,
    protocol: "",
    url: "",
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  } as unknown as WebSocket
}

function getSentMessages(ws: WebSocket): Array<WSMessage> {
  const sendMock = ws.send as ReturnType<typeof mock>
  return sendMock.mock.calls.map((call: Array<unknown>) => JSON.parse(call[0] as string))
}

function getLastSentMessage(ws: WebSocket): WSMessage {
  const msgs = getSentMessages(ws)
  return msgs.at(-1)
}

const sampleRequest: RecordRequestParams = {
  model: "claude-sonnet-4-20250514",
  messages: [{ role: "user", content: "Hello" }],
  stream: false,
}

const sampleResponse: RecordResponseParams = {
  success: true,
  model: "claude-sonnet-4-20250514",
  usage: { input_tokens: 10, output_tokens: 20 },
  stop_reason: "end_turn",
  content: { role: "assistant", content: "Hi there!" },
}

// ─── Setup / Teardown ───

beforeEach(() => {
  initHistory(true, 200)
})

afterEach(() => {
  closeAllClients()
  clearHistory()
})

// ─── recordRequest → entry_added ───

describe("recordRequest triggers WS notification", () => {
  test("connected client receives entry_added when request is recorded", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const id = recordRequest("anthropic", sampleRequest)
    expect(id).toBeTruthy()

    const msg = getLastSentMessage(ws)
    expect(msg.type).toBe("entry_added")
    expect(msg.data).toMatchObject({
      id,
      endpoint: "anthropic",
      request: {
        model: sampleRequest.model,
        stream: false,
      },
    })
  })

  test("multiple clients all receive entry_added", () => {
    const ws1 = createMockWebSocket()
    const ws2 = createMockWebSocket()
    const ws3 = createMockWebSocket()
    addClient(ws1)
    addClient(ws2)
    addClient(ws3)

    recordRequest("anthropic", sampleRequest)

    for (const ws of [ws1, ws2, ws3]) {
      const msg = getLastSentMessage(ws)
      expect(msg.type).toBe("entry_added")
    }
  })

  test("no error when recording request with zero clients", () => {
    expect(getClientCount()).toBe(0)
    const id = recordRequest("anthropic", sampleRequest)
    expect(id).toBeTruthy()
  })

  test("entry_added contains full message content", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const complexRequest: RecordRequestParams = {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "What is 2+2?" },
        { role: "assistant", content: "4" },
        { role: "user", content: "Thanks" },
      ],
      stream: true,
      tools: [{ name: "calculator", description: "A calculator" }],
      max_tokens: 1024,
      temperature: 0.7,
      system: "Be concise",
    }

    recordRequest("openai", complexRequest)

    const msg = getLastSentMessage(ws)
    expect(msg.type).toBe("entry_added")

    const entry = msg.data as Record<string, unknown>
    const request = entry.request as Record<string, unknown>
    expect(request.model).toBe("claude-sonnet-4-20250514")
    expect(request.stream).toBe(true)
    expect(request.max_tokens).toBe(1024)
    expect(request.temperature).toBe(0.7)
    expect(request.system).toBe("Be concise")
    expect((request.messages as Array<unknown>).length).toBe(4)
    expect((request.tools as Array<unknown>).length).toBe(1)
    expect(entry.endpoint).toBe("openai")
  })
})

// ─── recordResponse → entry_updated ───

describe("recordResponse triggers WS notification", () => {
  test("connected client receives entry_updated when response is recorded", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const id = recordRequest("anthropic", sampleRequest)
    recordResponse(id, sampleResponse, 150)

    const msg = getLastSentMessage(ws)
    expect(msg.type).toBe("entry_updated")
    expect(msg.data).toMatchObject({
      id,
      response: {
        success: true,
        model: sampleResponse.model,
        usage: sampleResponse.usage,
        stop_reason: "end_turn",
      },
      durationMs: 150,
    })
  })

  test("entry_updated contains both request and response data", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const id = recordRequest("anthropic", sampleRequest)
    recordResponse(id, sampleResponse, 200)

    const msg = getLastSentMessage(ws)
    const entry = msg.data as Record<string, unknown>
    // Should contain both request and response
    expect(entry.request).toBeDefined()
    expect(entry.response).toBeDefined()
    expect(entry.durationMs).toBe(200)
  })

  test("error response triggers entry_updated", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const id = recordRequest("anthropic", sampleRequest)
    recordResponse(
      id,
      {
        success: false,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 10, output_tokens: 0 },
        error: "Rate limited",
        content: null,
      },
      50,
    )

    const msg = getLastSentMessage(ws)
    expect(msg.type).toBe("entry_updated")
    const response = (msg.data as Record<string, unknown>).response as Record<string, unknown>
    expect(response.success).toBe(false)
    expect(response.error).toBe("Rate limited")
  })
})

// ─── recordRewrites → entry_updated ───

describe("recordRewrites triggers WS notification", () => {
  test("connected client receives entry_updated when rewrites are recorded", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const id = recordRequest("anthropic", sampleRequest)
    const rewrites: RewriteInfo = {
      truncation: {
        removedMessageCount: 3,
        originalTokens: 8000,
        compactedTokens: 4000,
        processingTimeMs: 8,
      },
      sanitization: {
        totalBlocksRemoved: 2,
        orphanedToolUseCount: 1,
        orphanedToolResultCount: 1,
        fixedNameCount: 0,
        emptyTextBlocksRemoved: 0,
        systemReminderRemovals: 1,
      },
      rewrittenMessages: [{ role: "user", content: "Simplified" }],
      messageMapping: [0],
    }
    recordRewrites(id, rewrites)

    const msg = getLastSentMessage(ws)
    expect(msg.type).toBe("entry_updated")
    const entry = msg.data as Record<string, unknown>
    expect(entry.rewrites).toMatchObject({
      truncation: rewrites.truncation,
      sanitization: rewrites.sanitization,
    })
  })
})

// ─── Full lifecycle: request → rewrites → response ───

describe("full request lifecycle", () => {
  test("client receives all notifications in correct order", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    // 1. Record request
    const id = recordRequest("anthropic", sampleRequest)

    // 2. Record rewrites (with truncation)
    recordRewrites(id, {
      truncation: {
        removedMessageCount: 2,
        originalTokens: 5000,
        compactedTokens: 3000,
        processingTimeMs: 5,
      },
    })

    // 3. Record response
    recordResponse(id, sampleResponse, 300)

    // Messages: connected + entry_added + entry_updated(rewrites) + entry_updated(response)
    const msgs = getSentMessages(ws)
    expect(msgs).toHaveLength(4)
    expect(msgs[0].type).toBe("connected")
    expect(msgs[1].type).toBe("entry_added")
    expect(msgs[2].type).toBe("entry_updated")
    expect(msgs[3].type).toBe("entry_updated")

    // Final entry_updated should have response
    const finalEntry = msgs[3].data as Record<string, unknown>
    expect(finalEntry.response).toBeDefined()
    expect(finalEntry.durationMs).toBe(300)
  })

  test("multiple sequential requests each trigger their own notifications", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const id1 = recordRequest("anthropic", sampleRequest)
    recordResponse(id1, sampleResponse, 100)

    const id2 = recordRequest("openai", { ...sampleRequest, model: "gpt-4o" })
    recordResponse(id2, { ...sampleResponse, model: "gpt-4o" }, 200)

    // connected + (entry_added + entry_updated) × 2 = 5
    const msgs = getSentMessages(ws)
    expect(msgs).toHaveLength(5)

    // Verify each request has its own entry ID
    const addedIds = msgs.filter((m) => m.type === "entry_added").map((m) => (m.data as Record<string, unknown>).id)
    expect(addedIds).toEqual([id1, id2])
    expect(addedIds[0]).not.toBe(addedIds[1])
  })

  test("client connecting mid-lifecycle only receives subsequent events", () => {
    // Record request before any client connects
    const id = recordRequest("anthropic", sampleRequest)

    // Now connect client
    const ws = createMockWebSocket()
    addClient(ws)

    // Record response - client should only see this
    recordResponse(id, sampleResponse, 100)

    const msgs = getSentMessages(ws)
    expect(msgs).toHaveLength(2) // connected + entry_updated
    expect(msgs[0].type).toBe("connected")
    expect(msgs[1].type).toBe("entry_updated")
    // Client did NOT receive entry_added (happened before connection)
  })

  test("disconnected client does not receive notifications", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const id = recordRequest("anthropic", sampleRequest)
    // Simulate disconnect
    ;(ws as unknown as { readyState: number }).readyState = WebSocket.CLOSED

    recordResponse(id, sampleResponse, 100)

    // After broadcast, the closed client should have been removed
    expect(getClientCount()).toBe(0)
  })
})

// ─── History disabled ───

describe("history disabled", () => {
  test("no WS notifications when history is disabled", () => {
    initHistory(false, 200)

    const ws = createMockWebSocket()
    addClient(ws)

    const id = recordRequest("anthropic", sampleRequest)
    expect(id).toBe("")

    // Only connected message, no entry_added
    const msgs = getSentMessages(ws)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].type).toBe("connected")
  })
})
