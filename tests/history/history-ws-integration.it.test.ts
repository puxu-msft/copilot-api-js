/**
 * Integration tests for history WebSocket notifications.
 *
 * Verifies the real data flow: store operations (insertEntry, updateEntry)
 * trigger WebSocket broadcasts of EntrySummary to connected clients.
 *
 * Uses mock WebSocket clients to capture broadcast messages without needing
 * a real HTTP server or WebSocket upgrade.
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

import type {
  //
  ClientRequestLeg,
  EndpointType,
  EntrySummary,
  HistoryEntry,
  PipelineInfo,
} from "~/lib/history"
import type { WSMessage } from "~/lib/ws"

import {
  //
  clearHistory,
  getCurrentSession,
  initHistory,
  insertEntry,
  setHistoryPublisher,
  updateEntry,
} from "~/lib/history"
import { resetBusForTests } from "~/lib/observability"
import { attachWsSink } from "~/lib/observability/sinks/ws"
import { generateId } from "~/lib/utils"
import {
  //
  addClient,
  closeAllClients,
  getClientCount,
} from "~/lib/ws"

import {
  //
  createMockWebSocket,
  getSentMessages,
} from "../helpers/ws-mock"

// ─── Helpers ───

/** Get the last sent message of a specific type */
function getLastSentMessageOfType(ws: WebSocket, type: string): WSMessage {
  const msgs = getSentMessages(ws)
  return msgs.findLast((m) => m.type === type)!
}

/** Helper: create and insert a minimal history entry */
function createEntry(endpoint: EndpointType, clientRequest: Partial<ClientRequestLeg> & { model: string }): HistoryEntry {
  const sessionId = getCurrentSession(endpoint, generateId())
  const entry: HistoryEntry = {
    id: generateId(),
    sessionId,
    startedAt: Date.now(),
    endpoint,
    model: { requested: clientRequest.model },
    clientRequest: {
      format: endpoint,
      model: clientRequest.model,
      messages: clientRequest.messages ?? [{ role: "user", content: "Hello" }],
      stream: clientRequest.stream ?? false,
      tools: clientRequest.tools,
      max_tokens: clientRequest.max_tokens,
      temperature: clientRequest.temperature,
      system: clientRequest.system,
    },
  }
  insertEntry(entry)
  return entry
}

// ─── Setup / Teardown ───

let detachWsSink: (() => void) | undefined

beforeEach(() => {
  initHistory(true, 200)
  // Wire the bus chain that ws/broadcast.ts depends on after commit 3b:
  // entries.ts publishes history.* via historyState.publisher → WsSink
  // subscribes → calls notifyEntryAdded/etc → broadcasts to addClient'd WSes.
  const bus = resetBusForTests()
  const historyPub = bus.scope("history")
  setHistoryPublisher(historyPub)
  detachWsSink = attachWsSink(bus)
})

afterEach(() => {
  closeAllClients()
  clearHistory()
  detachWsSink?.()
  detachWsSink = undefined
  setHistoryPublisher(undefined)
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
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "claude-sonnet-4-20250514",
            usage: { input_tokens: 10, output_tokens: 20 },
            stopReason: "end_turn",
            body: { role: "assistant", content: "Hi there!" },
          },
        },
      ],
      _index: { derived: { responseSuccess: true, attemptCount: 1 } },
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
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "claude-sonnet-4-20250514",
            usage: { input_tokens: 10, output_tokens: 20 },
            body: null,
          },
        },
      ],
      _index: { derived: { responseSuccess: true, attemptCount: 1 } },
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
      _index: { derived: { attemptCount: 2, currentStrategy: "network-retry" } },
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
      attempts: [
        {
          index: 0,
          durationMs: 0,
          error: "Rate limited",
          upstreamResponse: {
            success: false,
            model: "claude-sonnet-4-20250514",
            usage: { input_tokens: 10, output_tokens: 0 },
            body: null,
          },
        },
      ],
      _index: { derived: { responseSuccess: false, failureReason: "Rate limited", attemptCount: 1 } },
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
          emptyThinkingBlocksRemoved: 0,
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
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "claude-sonnet-4-20250514",
            usage: { input_tokens: 10, output_tokens: 20 },
            stopReason: "end_turn",
            body: { role: "assistant", content: "Hi there!" },
          },
        },
      ],
      _index: { derived: { responseSuccess: true, attemptCount: 1 } },
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
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "claude-sonnet-4-20250514",
            usage: { input_tokens: 10, output_tokens: 20 },
            body: null,
          },
        },
      ],
      _index: { derived: { responseSuccess: true, attemptCount: 1 } },
      durationMs: 100,
    })

    const entry2 = createEntry("openai-chat-completions", { model: "gpt-4o" })
    updateEntry(entry2.id, {
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "gpt-4o",
            usage: { input_tokens: 10, output_tokens: 20 },
            body: null,
          },
        },
      ],
      _index: { derived: { responseSuccess: true, attemptCount: 1 } },
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
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "claude-sonnet-4-20250514",
            usage: { input_tokens: 10, output_tokens: 20 },
            body: null,
          },
        },
      ],
      _index: { derived: { responseSuccess: true, attemptCount: 1 } },
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
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "claude-sonnet-4-20250514",
            usage: { input_tokens: 10, output_tokens: 20 },
            body: null,
          },
        },
      ],
      _index: { derived: { responseSuccess: true, attemptCount: 1 } },
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
      model: { requested: "claude-sonnet-4-20250514" },
      clientRequest: {
        format: "anthropic-messages",
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

// ─── clearHistory → WS notifications ───

describe("clearHistory broadcasts WS notifications", () => {
  test("clearHistory broadcasts history_cleared and stats_updated", () => {
    const ws = createMockWebSocket()
    addClient(ws)

    createEntry("anthropic-messages", { model: "test" })
    ;(ws.send as ReturnType<typeof mock>).mockClear()

    clearHistory()

    const types = getSentMessages(ws).map((message) => message.type)
    expect(types).toContain("history_cleared")
    expect(types).toContain("stats_updated")
  })
})
