/**
 * Characterization tests for history recording
 *
 * Captures current behavior:
 * - initHistory enables/disables recording
 * - insertEntry creates entries with correct fields
 * - updateEntry updates entries with response/rewrite data
 * - getHistory filters, paginates, and sorts entries
 * - clearHistory resets state
 * - getStats computes aggregate statistics
 * - Session management and max entries enforcement
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { EndpointType, HistoryEntry, Session } from "~/lib/history"

import {
  clearHistory,
  getCurrentSession,
  getEntry,
  getHistory,
  getSession,
  getSessionEntries,
  getStats,
  historyState,
  initHistory,
  insertEntry,
  isHistoryEnabled,
  updateEntry,
} from "~/lib/history"
import { generateId } from "~/lib/utils"

/** Helper: create and insert a minimal history entry */
function createEntry(
  endpoint: EndpointType,
  request: Partial<HistoryEntry["request"]> & { model: string; messages: HistoryEntry["request"]["messages"] },
): HistoryEntry {
  const sessionId = getCurrentSession(endpoint)
  const entry: HistoryEntry = {
    id: generateId(),
    sessionId,
    timestamp: Date.now(),
    endpoint,
    request: {
      model: request.model,
      messages: request.messages,
      stream: request.stream ?? true,
      tools: request.tools,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      system: request.system,
    },
  }
  insertEntry(entry)
  return entry
}

// Reset history state before each test
beforeEach(() => {
  initHistory(true, 200)
})

afterEach(() => {
  clearHistory()
})

// ─── initHistory ───

describe("initHistory", () => {
  test("enables history when enabled=true", () => {
    initHistory(true, 100)
    expect(isHistoryEnabled()).toBe(true)
  })

  test("disables history when enabled=false", () => {
    initHistory(false, 100)
    expect(isHistoryEnabled()).toBe(false)
  })

  test("sets maxEntries", () => {
    initHistory(true, 50)
    expect(historyState.maxEntries).toBe(50)
  })

  test("resets entries and sessions", () => {
    // Add some data first
    createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "test" }],
    })
    expect(historyState.entries.length).toBe(1)

    // Re-init should clear everything
    initHistory(true, 200)
    expect(historyState.entries.length).toBe(0)
  })

  test("generates a session ID when enabled", () => {
    initHistory(true, 100)
    expect(historyState.currentSessionId).toBeTruthy()
  })
})

// ─── insertEntry ───

describe("insertEntry", () => {
  test("inserts entry and makes it retrievable", () => {
    const entry = createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    })

    expect(entry.id).toBeTruthy()
    expect(typeof entry.id).toBe("string")
    expect(getEntry(entry.id)).toBeDefined()
  })

  test("does not insert when disabled", () => {
    initHistory(false, 100)
    const sessionId = "test-session"
    const entry: HistoryEntry = {
      id: generateId(),
      sessionId,
      timestamp: Date.now(),
      endpoint: "anthropic-messages",
      request: {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
    }
    insertEntry(entry)
    expect(historyState.entries.length).toBe(0)
  })

  test("creates entry with correct fields", () => {
    const entry = createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      system: "You are helpful",
      max_tokens: 1024,
      temperature: 0.5,
      tools: [{ name: "search", description: "Search tool" }],
    })

    const stored = getEntry(entry.id)
    expect(stored).toBeDefined()
    expect(stored!.endpoint).toBe("anthropic-messages")
    expect(stored!.request.model).toBe("claude-sonnet-4-20250514")
    expect(stored!.request.messages).toHaveLength(1)
    expect(stored!.request.stream).toBe(true)
    expect(stored!.request.system).toBe("You are helpful")
    expect(stored!.request.max_tokens).toBe(1024)
    expect(stored!.request.temperature).toBe(0.5)
    expect(stored!.request.tools).toHaveLength(1)
    expect(stored!.response).toBeUndefined()
  })

  test("assigns sessionId to entry", () => {
    const entry = createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "test" }],
    })

    expect(entry.sessionId).toBeTruthy()
  })

  test("tracks tools used in session", () => {
    createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "test" }],
      tools: [{ name: "file_search" }, { name: "read_file" }],
    })

    const session = historyState.sessions.get(historyState.currentSessionId)
    expect(session).toBeDefined()
    expect(session!.toolsUsed).toContain("file_search")
    expect(session!.toolsUsed).toContain("read_file")
  })

  test("increments session request count", () => {
    createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "1" }],
    })
    createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "2" }],
    })

    const session = historyState.sessions.get(historyState.currentSessionId)
    expect(session!.requestCount).toBe(2)
  })
})

// ─── updateEntry (response) ───

describe("updateEntry (response)", () => {
  test("updates entry with response data", () => {
    const entry = createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    })

    updateEntry(entry.id, {
      response: {
        success: true,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 100, output_tokens: 50 },
        stop_reason: "end_turn",
        content: { role: "assistant", content: "Hi there" },
      },
      durationMs: 500,
    })

    const stored = getEntry(entry.id)
    expect(stored!.response).toBeDefined()
    expect(stored!.response!.success).toBe(true)
    expect(stored!.response!.model).toBe("claude-sonnet-4-20250514")
    expect(stored!.response!.usage.input_tokens).toBe(100)
    expect(stored!.response!.usage.output_tokens).toBe(50)
    expect(stored!.response!.stop_reason).toBe("end_turn")
    expect(stored!.durationMs).toBe(500)
  })

  test("preserves cache_creation_input_tokens in usage", () => {
    const entry = createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    })

    updateEntry(entry.id, {
      response: {
        success: true,
        model: "claude-sonnet-4-20250514",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 20,
        },
        stop_reason: "end_turn",
        content: null,
      },
    })

    const stored = getEntry(entry.id)
    expect(stored!.response!.usage.cache_read_input_tokens).toBe(80)
    expect(stored!.response!.usage.cache_creation_input_tokens).toBe(20)
  })

  test("records error response", () => {
    const entry = createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    })

    updateEntry(entry.id, {
      response: {
        success: false,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 0, output_tokens: 0 },
        error: "Rate limited",
        content: null,
      },
      durationMs: 100,
    })

    const stored = getEntry(entry.id)
    expect(stored!.response!.success).toBe(false)
    expect(stored!.response!.error).toBe("Rate limited")
  })

  test("does nothing when disabled", () => {
    initHistory(false, 100)
    updateEntry("nonexistent", {
      response: {
        success: true,
        model: "test",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: null,
      },
    })
    // Should not throw
  })

  test("updates session token stats", () => {
    const entry = createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    })

    updateEntry(entry.id, {
      response: {
        success: true,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 100, output_tokens: 50 },
        content: null,
      },
    })

    const session = historyState.sessions.get(historyState.currentSessionId)
    expect(session!.totalInputTokens).toBe(100)
    expect(session!.totalOutputTokens).toBe(50)
  })
})

// ─── updateEntry (rewrites) ───

describe("updateEntry (rewrites)", () => {
  test("adds rewrite info to entry", () => {
    const entry = createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    })

    updateEntry(entry.id, {
      pipelineInfo: {
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
      },
    })

    const stored = getEntry(entry.id)
    expect(stored!.pipelineInfo).toBeDefined()
    expect(stored!.pipelineInfo!.sanitization![0].totalBlocksRemoved).toBe(2)
    expect(stored!.pipelineInfo!.messageMapping).toEqual([0])
  })

  test("stores truncation within pipelineInfo", () => {
    const entry = createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    })

    updateEntry(entry.id, {
      pipelineInfo: {
        truncation: {
          wasTruncated: true,
          removedMessageCount: 3,
          originalTokens: 8000,
          compactedTokens: 4000,
          processingTimeMs: 30,
        },
      },
    })

    const stored = getEntry(entry.id)
    expect(stored!.pipelineInfo!.truncation).toBeDefined()
    expect(stored!.pipelineInfo!.truncation!.removedMessageCount).toBe(3)
  })

  test("stores effectiveRequest via updateEntry", () => {
    const entry = createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    })

    updateEntry(entry.id, {
      effectiveRequest: {
        model: "claude-sonnet-4-20250514",
        format: "anthropic-messages",
        messageCount: 1,
        messages: [{ role: "user", content: "truncated" }],
        payload: {
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "truncated" }],
          max_tokens: 4096,
        },
      },
      wireRequest: {
        model: "claude-sonnet-4-20250514",
        format: "anthropic-messages",
        messageCount: 1,
        messages: [{ role: "user", content: "truncated" }],
        payload: {
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "truncated" }],
          max_tokens: 4096,
          stream: true,
        },
        headers: { "x-request-id": "abc" },
      },
    })

    const stored = getEntry(entry.id)
    expect(stored!.effectiveRequest).toBeDefined()
    expect(stored!.effectiveRequest!.model).toBe("claude-sonnet-4-20250514")
    expect(stored!.effectiveRequest!.messageCount).toBe(1)
    expect(stored!.effectiveRequest!.payload).toEqual({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "truncated" }],
      max_tokens: 4096,
    })
    expect(stored!.wireRequest).toEqual({
      model: "claude-sonnet-4-20250514",
      format: "anthropic-messages",
      messageCount: 1,
      messages: [{ role: "user", content: "truncated" }],
      payload: {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "truncated" }],
        max_tokens: 4096,
        stream: true,
      },
      headers: { "x-request-id": "abc" },
    })
  })

  test("stores attempts via updateEntry", () => {
    const entry = createEntry("anthropic-messages", { model: "m", messages: undefined })

    updateEntry(entry.id, {
      attempts: [
        { index: 0, durationMs: 100, effectiveMessageCount: 10 },
        { index: 1, strategy: "auto-truncate", durationMs: 200, effectiveMessageCount: 5 },
      ],
    })

    const stored = getEntry(entry.id)
    expect(stored!.attempts).toHaveLength(2)
    expect(stored!.attempts![1].strategy).toBe("auto-truncate")
    expect(stored!.attempts![1].effectiveMessageCount).toBe(5)
  })

  test("stores response with status, rawBody, and headers", () => {
    const entry = createEntry("anthropic-messages", { model: "m", messages: undefined })

    updateEntry(entry.id, {
      response: {
        success: false,
        model: "claude-sonnet-4",
        usage: { input_tokens: 0, output_tokens: 0 },
        error: "Bad request",
        status: 400,
        content: null,
        rawBody: '{"error":"thinking blocks cannot be modified"}',
        headers: { "x-request-id": "xyz" },
      },
    })

    const stored = getEntry(entry.id)
    expect(stored!.response!.status).toBe(400)
    expect(stored!.response!.rawBody).toBe('{"error":"thinking blocks cannot be modified"}')
    expect(stored!.response!.headers).toEqual({ "x-request-id": "xyz" })
  })
})

// ─── getHistory ───

describe("getHistory", () => {
  test("returns entries sorted by timestamp descending", () => {
    createEntry("anthropic-messages", {
      model: "model-a",
      messages: [{ role: "user", content: "first" }],
    })
    createEntry("anthropic-messages", {
      model: "model-b",
      messages: [{ role: "user", content: "second" }],
    })

    const result = getHistory()
    expect(result.entries.length).toBe(2)
    expect(result.entries[0].timestamp).toBeGreaterThanOrEqual(result.entries[1].timestamp)
  })

  test("paginates results", () => {
    for (let i = 0; i < 5; i++) {
      createEntry("anthropic-messages", {
        model: "model",
        messages: [{ role: "user", content: `msg-${i}` }],
      })
    }

    const page1 = getHistory({ limit: 2 })
    expect(page1.entries.length).toBe(2)
    expect(page1.total).toBe(5)
    expect(page1.totalPages).toBe(3)

    // Use last entry's ID as cursor to get next page
    const page2 = getHistory({ cursor: page1.entries.at(-1)!.id, limit: 2 })
    expect(page2.entries.length).toBe(2)
  })

  test("filters by model name", () => {
    createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "a" }],
    })
    createEntry("anthropic-messages", {
      model: "gpt-4o",
      messages: [{ role: "user", content: "b" }],
    })

    const result = getHistory({ model: "claude" })
    expect(result.total).toBe(1)
    expect(result.entries[0].request.model).toContain("claude")
  })

  test("filters by endpoint", () => {
    createEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "a" }],
    })
    createEntry("openai-chat-completions", {
      model: "test",
      messages: [{ role: "user", content: "b" }],
    })

    const result = getHistory({ endpoint: "openai-chat-completions" })
    expect(result.total).toBe(1)
    expect(result.entries[0].endpoint).toBe("openai-chat-completions")
  })

  test("search finds OpenAI tool_calls by function name", () => {
    createEntry("openai-chat-completions", {
      model: "gpt-4o",
      messages: [
        { role: "user", content: "search the web" },
        {
          role: "assistant",
          content: "Let me search for that.",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "web_search", arguments: '{"query":"test"}' },
            },
          ],
        } as any,
      ],
    })
    createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    })

    const result = getHistory({ search: "web_search" })
    expect(result.total).toBe(1)
    expect(result.entries[0].request.model).toBe("gpt-4o")
  })

  test("search finds OpenAI tool_calls by function arguments", () => {
    createEntry("openai-chat-completions", {
      model: "gpt-4o",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_456",
              type: "function",
              function: { name: "calculator", arguments: '{"expression":"2+2"}' },
            },
          ],
        } as any,
      ],
    })

    const result = getHistory({ search: "expression" })
    expect(result.total).toBe(1)
  })

  test("filters by timestamp range (to)", () => {
    const now = Date.now()
    const sessionId = getCurrentSession("anthropic-messages")

    const old: HistoryEntry = {
      id: generateId(),
      sessionId,
      timestamp: now - 10000,
      endpoint: "anthropic-messages",
      request: { model: "test", messages: [{ role: "user", content: "old" }], stream: true },
    }
    insertEntry(old)

    const recent: HistoryEntry = {
      id: generateId(),
      sessionId,
      timestamp: now,
      endpoint: "anthropic-messages",
      request: { model: "test", messages: [{ role: "user", content: "new" }], stream: true },
    }
    insertEntry(recent)

    const result = getHistory({ to: now - 5000 })
    expect(result.total).toBe(1)
    expect(result.entries[0].id).toBe(old.id)
  })

  test("filters by timestamp range (from + to)", () => {
    const now = Date.now()
    const sessionId = getCurrentSession("anthropic-messages")

    const old: HistoryEntry = {
      id: generateId(),
      sessionId,
      timestamp: now - 20000,
      endpoint: "anthropic-messages",
      request: { model: "test", messages: [{ role: "user", content: "old" }], stream: true },
    }
    insertEntry(old)

    const mid: HistoryEntry = {
      id: generateId(),
      sessionId,
      timestamp: now - 10000,
      endpoint: "anthropic-messages",
      request: { model: "test", messages: [{ role: "user", content: "mid" }], stream: true },
    }
    insertEntry(mid)

    const recent: HistoryEntry = {
      id: generateId(),
      sessionId,
      timestamp: now,
      endpoint: "anthropic-messages",
      request: { model: "test", messages: [{ role: "user", content: "new" }], stream: true },
    }
    insertEntry(recent)

    const result = getHistory({ from: now - 15000, to: now - 5000 })
    expect(result.total).toBe(1)
    expect(result.entries[0].id).toBe(mid.id)
  })
})

// ─── updateEntry: sseEvents ───

describe("updateEntry stores sseEvents", () => {
  test("sseEvents are persisted via updateEntry", () => {
    const entry = createEntry("anthropic-messages", { model: "test", messages: [{ role: "user", content: "hi" }] })

    const sseEvents = [
      { offsetMs: 0, type: "message_start", data: { type: "message_start" } },
      { offsetMs: 50, type: "content_block_delta", data: { type: "content_block_delta" } },
      { offsetMs: 100, type: "message_stop", data: { type: "message_stop" } },
    ]

    updateEntry(entry.id, { sseEvents })

    const updated = getEntry(entry.id)
    expect(updated?.sseEvents).toEqual(sseEvents)
    expect(updated?.sseEvents).toHaveLength(3)
  })

  test("sseEvents can be set alongside response", () => {
    const entry = createEntry("anthropic-messages", { model: "test", messages: [{ role: "user", content: "hi" }] })

    updateEntry(entry.id, {
      response: {
        success: true,
        model: "test",
        usage: { input_tokens: 10, output_tokens: 5 },
        content: null,
      },
      sseEvents: [{ offsetMs: 0, type: "message_start", data: {} }],
      durationMs: 100,
    })

    const updated = getEntry(entry.id)
    expect(updated?.response?.success).toBe(true)
    expect(updated?.sseEvents).toHaveLength(1)
    expect(updated?.durationMs).toBe(100)
  })
})

// ─── Session.endpoints tracking ───

describe("Session.endpoints tracking", () => {
  test("new session records initial endpoint", () => {
    const sessionId = getCurrentSession("anthropic-messages")
    const session = getSession(sessionId) as Session
    expect(session.endpoints).toEqual(["anthropic-messages"])
  })

  test("same endpoint is not duplicated", () => {
    getCurrentSession("anthropic-messages")
    getCurrentSession("anthropic-messages")
    getCurrentSession("anthropic-messages")
    const sessionId = getCurrentSession("anthropic-messages")

    const session = getSession(sessionId) as Session
    expect(session.endpoints).toEqual(["anthropic-messages"])
  })

  test("different endpoints accumulate", () => {
    getCurrentSession("anthropic-messages")
    getCurrentSession("openai-chat-completions")
    const sessionId = getCurrentSession("openai-responses")

    const session = getSession(sessionId) as Session
    expect(session.endpoints).toEqual(["anthropic-messages", "openai-chat-completions", "openai-responses"])
  })
})

// ─── getSessionEntries pagination ───

describe("getSessionEntries pagination", () => {
  test("returns paginated results with default limit", () => {
    const sessionId = getCurrentSession("anthropic-messages")

    for (let i = 0; i < 5; i++) {
      const entry: HistoryEntry = {
        id: generateId(),
        sessionId,
        timestamp: Date.now() + i,
        endpoint: "anthropic-messages",
        request: { model: "test", messages: [{ role: "user", content: `msg ${i}` }] },
      }
      insertEntry(entry)
    }

    const result = getSessionEntries(sessionId)
    expect(result.total).toBe(5)
    expect(result.entries).toHaveLength(5)
    expect(result.prevCursor).toBeNull()
  })

  test("respects cursor and limit", () => {
    const sessionId = getCurrentSession("anthropic-messages")

    for (let i = 0; i < 10; i++) {
      const entry: HistoryEntry = {
        id: generateId(),
        sessionId,
        timestamp: Date.now() + i,
        endpoint: "anthropic-messages",
        request: { model: "test", messages: [{ role: "user", content: `msg ${i}` }] },
      }
      insertEntry(entry)
    }

    // First page: no cursor
    const page1 = getSessionEntries(sessionId, { limit: 3 })
    expect(page1.total).toBe(10)
    expect(page1.entries).toHaveLength(3)
    expect(page1.nextCursor).not.toBeNull()
    expect(page1.prevCursor).toBeNull()

    // Second page: use last entry ID from first page as cursor
    const page2 = getSessionEntries(sessionId, { cursor: page1.entries.at(-1)!.id, limit: 3 })
    expect(page2.entries).toHaveLength(3)
    expect(page2.prevCursor).not.toBeNull()

    // Different entries on different pages
    expect(page1.entries[0].id).not.toBe(page2.entries[0].id)
  })

  test("returns empty for non-existent session", () => {
    const result = getSessionEntries("nonexistent")
    expect(result.total).toBe(0)
    expect(result.entries).toHaveLength(0)
  })
})

// ─── clearHistory ───

describe("clearHistory", () => {
  test("removes all entries and sessions", () => {
    createEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "hello" }],
    })

    expect(historyState.entries.length).toBe(1)

    clearHistory()

    expect(historyState.entries.length).toBe(0)
    expect(historyState.sessions.size).toBe(0)
  })

  test("generates new session ID after clearing", () => {
    const oldSessionId = historyState.currentSessionId
    clearHistory()
    expect(historyState.currentSessionId).not.toBe(oldSessionId)
  })
})

// ─── getStats ───

describe("getStats", () => {
  test("returns aggregate statistics", () => {
    const entry = createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    })

    updateEntry(entry.id, {
      response: {
        success: true,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 100, output_tokens: 50 },
        content: null,
      },
      durationMs: 500,
    })

    const stats = getStats()
    expect(stats.totalRequests).toBe(1)
    expect(stats.successfulRequests).toBe(1)
    expect(stats.failedRequests).toBe(0)
    expect(stats.totalInputTokens).toBe(100)
    expect(stats.totalOutputTokens).toBe(50)
    expect(stats.averageDurationMs).toBe(500)
    expect(stats.modelDistribution["claude-sonnet-4-20250514"]).toBe(1)
    expect(stats.endpointDistribution["anthropic-messages"]).toBe(1)
  })
})

// ─── Max entries enforcement ───

describe("Max entries enforcement", () => {
  test("removes oldest entries when exceeding maxEntries", () => {
    initHistory(true, 3)

    const entries: Array<HistoryEntry> = []
    for (let i = 0; i < 5; i++) {
      entries.push(
        createEntry("anthropic-messages", {
          model: "test",
          messages: [{ role: "user", content: `msg-${i}` }],
        }),
      )
    }

    expect(historyState.entries.length).toBe(3)
    // Oldest entries should be removed (FIFO)
    expect(getEntry(entries[0].id)).toBeUndefined()
    expect(getEntry(entries[1].id)).toBeUndefined()
    expect(getEntry(entries[2].id)).toBeDefined()
  })
})
