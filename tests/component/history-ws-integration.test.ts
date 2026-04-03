/**
 * Integration tests for history WebSocket notifications.
 *
 * Verifies the real data flow: store operations (insertEntry, updateEntry)
 * trigger WebSocket broadcasts of EntrySummary to connected clients.
 *
 * Uses mock WebSocket clients to capture broadcast messages without needing
 * a real HTTP server or WebSocket upgrade.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { EndpointType, EntrySummary, HistoryEntry, PipelineInfo, WSMessage } from "~/lib/history"

import {
  addClient,
  clearHistory,
  closeAllClients,
  deleteSession,
  getCurrentSession,
  getClientCount,
  initHistory,
  insertEntry,
  updateEntry,
} from "~/lib/history"
import { generateId } from "~/lib/utils"

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

/** Get the last sent message of a specific type */
function getLastSentMessageOfType(ws: WebSocket, type: string): WSMessage {
  const msgs = getSentMessages(ws)
  return msgs.findLast((m) => m.type === type)!
}

/** Helper: create and insert a minimal history entry */
function createEntry(
  endpoint: EndpointType,
  request: Partial<HistoryEntry["request"]> & { model: string },
): HistoryEntry {
  const sessionId = getCurrentSession(endpoint, generateId())
  const entry: HistoryEntry = {
    id: generateId(),
    sessionId,
    startedAt: Date.now(),
    endpoint,
    request: {
      model: request.model,
      messages: request.messages ?? [{ role: "user", content: "Hello" }],
      stream: request.stream ?? false,
      tools: request.tools,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      system: request.system,
    },
  }
  insertEntry(entry)
  return entry
}

// ─── Setup / Teardown ───

beforeEach(() => {
  initHistory(true, 200)
})

afterEach(() => {
  closeAllClients()
  clearHistory()
})

// ─── insertEntry → entry_added (EntrySummary) ───

describe("insertEntry triggers WS notification", () => {
  test("connected client receives entry_added with summary when entry is inserted", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const entry = createEntry("anthropic-messages", { model: "claude-sonnet-4-20250514" })

    const msg = getLastSentMessageOfType(ws, "entry_added")
    expect(msg.type).toBe("entry_added")
    const summary = msg.data as EntrySummary
    expect(summary.id).toBe(entry.id)
    expect(summary.endpoint).toBe("anthropic-messages")
    expect(summary.requestModel).toBe("claude-sonnet-4-20250514")
    expect(summary.stream).toBe(false)
    expect(summary.state).toBeUndefined()
  })

  test("multiple clients all receive entry_added", () => {
    const ws1 = createMockWebSocket()
    const ws2 = createMockWebSocket()
    const ws3 = createMockWebSocket()
    addClient(ws1)
    addClient(ws2)
    addClient(ws3)

    createEntry("anthropic-messages", { model: "claude-sonnet-4-20250514" })

    for (const ws of [ws1, ws2, ws3]) {
      const msg = getLastSentMessageOfType(ws, "entry_added")
      expect(msg.type).toBe("entry_added")
    }
  })

  test("no error when inserting entry with zero clients", () => {
    expect(getClientCount()).toBe(0)
    const entry = createEntry("anthropic-messages", { model: "claude-sonnet-4-20250514" })
    expect(entry.id).toBeTruthy()
  })

  test("entry_added summary contains key fields", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    createEntry("openai-chat-completions", {
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
    })

    const msg = getLastSentMessageOfType(ws, "entry_added")
    expect(msg.type).toBe("entry_added")

    const summary = msg.data as EntrySummary
    expect(summary.requestModel).toBe("claude-sonnet-4-20250514")
    expect(summary.stream).toBe(true)
    expect(summary.messageCount).toBe(4)
    expect(summary.endpoint).toBe("openai-chat-completions")
    // Preview text should be the last user message
    expect(summary.previewText).toBe("Thanks")
  })
})

// ─── updateEntry (response) → entry_updated (EntrySummary) ───

describe("updateEntry (response) triggers WS notification", () => {
  test("connected client receives entry_updated summary when response is recorded", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const entry = createEntry("anthropic-messages", { model: "claude-sonnet-4-20250514" })
    updateEntry(entry.id, {
      response: {
        success: true,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 10, output_tokens: 20 },
        stop_reason: "end_turn",
        content: { role: "assistant", content: "Hi there!" },
      },
      durationMs: 150,
    })

    const msg = getLastSentMessageOfType(ws, "entry_updated")
    expect(msg.type).toBe("entry_updated")
    const summary = msg.data as EntrySummary
    expect(summary.id).toBe(entry.id)
    expect(summary.responseSuccess).toBe(true)
    expect(summary.responseModel).toBe("claude-sonnet-4-20250514")
    expect(summary.usage).toEqual({ input_tokens: 10, output_tokens: 20 })
    expect(summary.durationMs).toBe(150)
  })

  test("entry_updated summary contains both request and response metadata", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const entry = createEntry("anthropic-messages", { model: "claude-sonnet-4-20250514" })
    updateEntry(entry.id, {
      response: {
        success: true,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 10, output_tokens: 20 },
        content: null,
      },
      durationMs: 200,
    })

    const msg = getLastSentMessageOfType(ws, "entry_updated")
    const summary = msg.data as EntrySummary
    // Summary should contain both request and response metadata
    expect(summary.requestModel).toBe("claude-sonnet-4-20250514")
    expect(summary.responseSuccess).toBe(true)
    expect(summary.durationMs).toBe(200)
  })

  test("lifecycle updates are reflected in entry_updated summaries", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const entry = createEntry("anthropic-messages", { model: "claude-sonnet-4-20250514" })
    updateEntry(entry.id, {
      state: "streaming",
      active: true,
      queueWaitMs: 320,
      attemptCount: 2,
      currentStrategy: "network-retry",
      startedAt: entry.startedAt,
      lastUpdatedAt: entry.startedAt + 320,
      durationMs: 320,
    })

    const msg = getLastSentMessageOfType(ws, "entry_updated")
    const summary = msg.data as EntrySummary
    expect(summary.state).toBe("streaming")
    expect(summary.active).toBe(true)
    expect(summary.queueWaitMs).toBe(320)
    expect(summary.attemptCount).toBe(2)
    expect(summary.currentStrategy).toBe("network-retry")
  })

  test("error response triggers entry_updated with error info", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const entry = createEntry("anthropic-messages", { model: "claude-sonnet-4-20250514" })
    updateEntry(entry.id, {
      response: {
        success: false,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 10, output_tokens: 0 },
        error: "Rate limited",
        content: null,
      },
      durationMs: 50,
    })

    const msg = getLastSentMessageOfType(ws, "entry_updated")
    expect(msg.type).toBe("entry_updated")
    const summary = msg.data as EntrySummary
    expect(summary.responseSuccess).toBe(false)
    expect(summary.responseError).toBe("Rate limited")
  })
})

// ─── updateEntry (pipelineInfo) → entry_updated ───

describe("updateEntry (pipelineInfo) triggers WS notification", () => {
  test("connected client receives entry_updated when pipelineInfo is recorded", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const entry = createEntry("anthropic-messages", { model: "claude-sonnet-4-20250514" })
    const pipeInfo: PipelineInfo = {
      truncation: {
        wasTruncated: true,
        removedMessageCount: 3,
        originalTokens: 8000,
        compactedTokens: 4000,
        processingTimeMs: 8,
      },
      sanitization: [
        {
          totalBlocksRemoved: 2,
          orphanedToolUseCount: 1,
          orphanedToolResultCount: 1,
          fixedNameCount: 0,
          emptyTextBlocksRemoved: 0,
          systemReminderRemovals: 1,
        },
      ],
      messageMapping: [0],
    }
    updateEntry(entry.id, { pipelineInfo: pipeInfo })

    const msg = getLastSentMessageOfType(ws, "entry_updated")
    expect(msg.type).toBe("entry_updated")
    // PipelineInfo doesn't appear in the summary — the update just triggers a summary rebuild
    const summary = msg.data as EntrySummary
    expect(summary.id).toBe(entry.id)
  })
})

// ─── Full lifecycle: insert → pipelineInfo → response ───

describe("full request lifecycle", () => {
  test("client receives all notifications in correct order", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    // 1. Insert entry
    const entry = createEntry("anthropic-messages", { model: "claude-sonnet-4-20250514" })

    // 2. Update with pipelineInfo
    updateEntry(entry.id, {
      pipelineInfo: {
        truncation: {
          wasTruncated: true,
          removedMessageCount: 2,
          originalTokens: 5000,
          compactedTokens: 3000,
          processingTimeMs: 5,
        },
      },
    })

    // 3. Update with response
    updateEntry(entry.id, {
      response: {
        success: true,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 10, output_tokens: 20 },
        stop_reason: "end_turn",
        content: { role: "assistant", content: "Hi there!" },
      },
      durationMs: 300,
    })

    // Messages: connected + entry_added + stats + entry_updated(pipelineInfo) + stats + entry_updated(response) + stats
    const msgs = getSentMessages(ws)
    expect(msgs).toHaveLength(7)
    expect(msgs[0].type).toBe("connected")
    expect(msgs[1].type).toBe("entry_added")
    expect(msgs[2].type).toBe("stats_updated")
    expect(msgs[3].type).toBe("entry_updated")
    expect(msgs[4].type).toBe("stats_updated")
    expect(msgs[5].type).toBe("entry_updated")
    expect(msgs[6].type).toBe("stats_updated")

    // Final entry_updated should have response metadata in summary
    const finalSummary = msgs[5].data as EntrySummary
    expect(finalSummary.responseSuccess).toBe(true)
    expect(finalSummary.durationMs).toBe(300)
  })

  test("multiple sequential requests each trigger their own notifications", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const entry1 = createEntry("anthropic-messages", { model: "claude-sonnet-4-20250514" })
    updateEntry(entry1.id, {
      response: {
        success: true,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 10, output_tokens: 20 },
        content: null,
      },
      durationMs: 100,
    })

    const entry2 = createEntry("openai-chat-completions", { model: "gpt-4o" })
    updateEntry(entry2.id, {
      response: {
        success: true,
        model: "gpt-4o",
        usage: { input_tokens: 10, output_tokens: 20 },
        content: null,
      },
      durationMs: 200,
    })

    // connected + (entry_added + stats + entry_updated + stats) × 2 = 9
    const msgs = getSentMessages(ws)
    expect(msgs).toHaveLength(9)

    // Verify each request has its own entry ID
    const addedIds = msgs.filter((m) => m.type === "entry_added").map((m) => (m.data as EntrySummary).id)
    expect(addedIds).toEqual([entry1.id, entry2.id])
    expect(addedIds[0]).not.toBe(addedIds[1])
  })

  test("client connecting mid-lifecycle only receives subsequent events", () => {
    // Insert entry before any client connects
    const entry = createEntry("anthropic-messages", { model: "claude-sonnet-4-20250514" })

    // Now connect client
    const ws = createMockWebSocket()
    addClient(ws)

    // Update with response - client should only see this
    updateEntry(entry.id, {
      response: {
        success: true,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 10, output_tokens: 20 },
        content: null,
      },
      durationMs: 100,
    })

    const msgs = getSentMessages(ws)
    expect(msgs).toHaveLength(3) // connected + entry_updated + stats_updated
    expect(msgs[0].type).toBe("connected")
    expect(msgs[1].type).toBe("entry_updated")
    expect(msgs[2].type).toBe("stats_updated")
    // Client did NOT receive entry_added (happened before connection)
  })

  test("disconnected client does not receive notifications", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const entry = createEntry("anthropic-messages", { model: "claude-sonnet-4-20250514" })
    // Simulate disconnect
    ;(ws as unknown as { readyState: number }).readyState = WebSocket.CLOSED

    updateEntry(entry.id, {
      response: {
        success: true,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 10, output_tokens: 20 },
        content: null,
      },
      durationMs: 100,
    })

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

    // insertEntry does nothing when disabled
    const sessionId = "fake"
    const entry: HistoryEntry = {
      id: generateId(),
      sessionId,
      startedAt: Date.now(),
      endpoint: "anthropic-messages",
      request: {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      },
    }
    insertEntry(entry)

    // Only connected message, no entry_added
    const msgs = getSentMessages(ws)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].type).toBe("connected")
  })
})

// ─── clearHistory / deleteSession → WS notifications ───

describe("clearHistory and deleteSession broadcast WS notifications", () => {
  test("clearHistory broadcasts history_cleared and stats_updated", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    createEntry("anthropic-messages", { model: "test" })
    // Clear sent messages to isolate clearHistory effects
    ;(ws.send as ReturnType<typeof mock>).mockClear()

    clearHistory()

    const msgs = getSentMessages(ws)
    const types = msgs.map((m) => m.type)
    expect(types).toContain("history_cleared")
    expect(types).toContain("stats_updated")
  })

  test("deleteSession broadcasts session_deleted and stats_updated", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    const entry = createEntry("anthropic-messages", { model: "test" })
    expect(entry.sessionId).toBeTruthy()
    ;(ws.send as ReturnType<typeof mock>).mockClear()

    deleteSession(entry.sessionId!)

    const msgs = getSentMessages(ws)
    const types = msgs.map((m) => m.type)
    expect(types).toContain("session_deleted")
    expect(types).toContain("stats_updated")

    // session_deleted message includes sessionId
    const sessionMsg = msgs.find((m) => m.type === "session_deleted")!
    expect((sessionMsg.data as { sessionId: string }).sessionId).toBe(entry.sessionId!)
  })
})
