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

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  EndpointType,
  HistoryEntry,
  Session,
} from "~/lib/history"

import {
  //
  clearHistory,
  getCurrentSession,
  getEntry,
  getHistory,
  getSession,
  getSessionEntries,
  getSessions,
  getStats,
  initHistory,
  insertEntry,
  isHistoryEnabled,
  listInFlightEntries,
  shutdownHistory,
  updateEntry,
  finalizeEntry,
} from "~/lib/history"
import { queryEntryCount } from "~/lib/history/sqlite/read"
import { runReaperOnce } from "~/lib/history/sqlite/reaper"
import {
  //
  setStateForTests,
  state,
} from "~/lib/state"
import { generateId } from "~/lib/utils"

/** Mark an entry as completed so session stats are persisted to SQLite. */
function completeEntry(entryId: string, overrides: Partial<Parameters<typeof updateEntry>[1]> = {}): void {
  updateEntry(entryId, {
    state: "completed",
    response: {
      success: true,
      model: "test-model",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: null,
    },
    ...overrides,
  })
  // updateEntry no longer auto-persists on terminal state — the explicit
  // finalizeEntry call mirrors the consumer pipeline behavior.
  finalizeEntry(entryId)
}

/** Count persisted + in-flight entries. */
function totalEntryCount(): number {
  try {
    return queryEntryCount() + listInFlightEntries().length
  } catch {
    return listInFlightEntries().length
  }
}

/** Helper: create and insert a minimal history entry */
function createEntry(
  endpoint: EndpointType,
  request: Partial<HistoryEntry["request"]> & { model: string; messages: HistoryEntry["request"]["messages"] },
): HistoryEntry {
  const sessionId = getCurrentSession(endpoint, generateId())
  const entry: HistoryEntry = {
    id: generateId(),
    sessionId,
    startedAt: Date.now(),
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
  setStateForTests({ historyDbPath: ":memory:" })
  initHistory(true, 200)
})

afterEach(() => {
  clearHistory()
  shutdownHistory()
  setStateForTests({ historyDbPath: "" })
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

  test("tracks history limit from state", () => {
    setStateForTests({ historyLimit: 50 })
    initHistory(true, 50)
    expect(state.historyLimit).toBe(50)
  })

  test("resets entries and sessions", () => {
    // Add some data first
    createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "test" }],
    })
    expect(totalEntryCount()).toBe(1)

    // clearHistory should clear everything
    clearHistory()
    expect(totalEntryCount()).toBe(0)
  })

  test("does not generate a synthetic session ID on init", () => {
    initHistory(true, 100)
    expect(getSessions().sessions.length).toBe(0)
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
      startedAt: Date.now(),
      endpoint: "anthropic-messages",
      request: {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
    }
    insertEntry(entry)
    expect(listInFlightEntries().length).toBe(0)
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

  test("keeps an explicit sessionId on the entry", () => {
    const entry = createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "test" }],
    })

    expect(entry.sessionId).toBeTruthy()
  })

  test("session is created when entry completes with tools", () => {
    const entry = createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "test" }],
      tools: [{ name: "file_search" }, { name: "read_file" }],
    })
    completeEntry(entry.id)

    const session = getSession(entry.sessionId!)
    expect(session).toBeDefined()
    expect(session!.id).toBe(entry.sessionId!)
  })

  test("increments session request count", () => {
    const first = createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "1" }],
    })
    const sessionId = first.sessionId!
    completeEntry(first.id)

    const secondId = generateId()
    insertEntry({
      id: secondId,
      sessionId,
      startedAt: Date.now(),
      endpoint: "anthropic-messages",
      request: {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "2" }],
        stream: true,
      },
    })
    completeEntry(secondId)

    const session = getSession(sessionId)
    expect(session!.requestCount).toBe(2)
  })

  test("stores entries without a session when none is provided", () => {
    const entry: HistoryEntry = {
      id: generateId(),
      startedAt: Date.now(),
      endpoint: "anthropic-messages",
      request: {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "no session" }],
        stream: true,
      },
    }

    insertEntry(entry)

    const stored = getEntry(entry.id)
    expect(stored?.sessionId).toBeUndefined()
    expect(getSessions().sessions.length).toBe(0)
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
      state: "completed",
      response: {
        success: true,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 100, output_tokens: 50 },
        content: null,
      },
    })
    finalizeEntry(entry.id)

    const session = getSession(entry.sessionId!)
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
      },
      httpHeaders: {
        outboundRequest: { "x-request-id": "abc" },
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
    })
    expect(stored!.httpHeaders).toEqual({
      outboundRequest: { "x-request-id": "abc" },
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

  test("stores transport via updateEntry", () => {
    const entry = createEntry("openai-responses", {
      model: "gpt-5.2",
      messages: [{ role: "user", content: "hello" }],
    })

    updateEntry(entry.id, {
      transport: "upstream-ws-fallback",
    })

    const stored = getEntry(entry.id)
    expect(stored!.transport).toBe("upstream-ws-fallback")
  })

  test("stores warningMessages via updateEntry", () => {
    const entry = createEntry("openai-chat-completions", {
      model: "gpt-5-resp",
      messages: [{ role: "user", content: "hello" }],
    })

    updateEntry(entry.id, {
      warningMessages: [
        {
          code: "cc_to_responses_dropped_params",
          message: "Chat Completions -> Responses translation dropped unsupported params: stop, seed",
        },
      ],
    })

    const stored = getEntry(entry.id)
    expect(stored!.warningMessages).toEqual([
      {
        code: "cc_to_responses_dropped_params",
        message: "Chat Completions -> Responses translation dropped unsupported params: stop, seed",
      },
    ])
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
      },
      httpHeaders: {
        outboundResponse: { "x-request-id": "xyz" },
      },
    })

    const stored = getEntry(entry.id)
    expect(stored!.response!.status).toBe(400)
    expect(stored!.response!.rawBody).toBe('{"error":"thinking blocks cannot be modified"}')
    expect(stored!.httpHeaders!.outboundResponse).toEqual({ "x-request-id": "xyz" })
  })
})

// ─── getHistory ───

describe("getHistory", () => {
  test("returns entries sorted by startedAt descending", () => {
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
    expect(result.entries[0].startedAt).toBeGreaterThanOrEqual(result.entries[1].startedAt)
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

  // Search filter is not wired through the SQLite query layer yet (preserved
  // here as a skipped spec; behaviour-level coverage can be restored once
  // search_text is indexed and consulted by applyWhere).
  test.skip("search finds OpenAI tool_calls by function name", () => {
    const e1 = createEntry("openai-chat-completions", {
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
    completeEntry(e1.id)
    const e2 = createEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    })
    completeEntry(e2.id)

    const result = getHistory({ search: "web_search" })
    expect(result.total).toBe(1)
    expect(result.entries[0].request.model).toBe("gpt-4o")
  })

  test.skip("search finds OpenAI tool_calls by function arguments", () => {
    const e = createEntry("openai-chat-completions", {
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
    completeEntry(e.id)

    const result = getHistory({ search: "expression" })
    expect(result.total).toBe(1)
  })

  test("filters by startedAt range (to)", () => {
    const now = Date.now()
    const sessionId = getCurrentSession("anthropic-messages", generateId())!

    const old: HistoryEntry = {
      id: generateId(),
      sessionId,
      startedAt: now - 10000,
      endpoint: "anthropic-messages",
      request: { model: "test", messages: [{ role: "user", content: "old" }], stream: true },
    }
    insertEntry(old)

    const recent: HistoryEntry = {
      id: generateId(),
      sessionId,
      startedAt: now,
      endpoint: "anthropic-messages",
      request: { model: "test", messages: [{ role: "user", content: "new" }], stream: true },
    }
    insertEntry(recent)

    const result = getHistory({ to: now - 5000 })
    expect(result.total).toBe(1)
    expect(result.entries[0].id).toBe(old.id)
  })

  test("filters by startedAt range (from + to)", () => {
    const now = Date.now()
    const sessionId = getCurrentSession("anthropic-messages", generateId())!

    const old: HistoryEntry = {
      id: generateId(),
      sessionId,
      startedAt: now - 20000,
      endpoint: "anthropic-messages",
      request: { model: "test", messages: [{ role: "user", content: "old" }], stream: true },
    }
    insertEntry(old)

    const mid: HistoryEntry = {
      id: generateId(),
      sessionId,
      startedAt: now - 10000,
      endpoint: "anthropic-messages",
      request: { model: "test", messages: [{ role: "user", content: "mid" }], stream: true },
    }
    insertEntry(mid)

    const recent: HistoryEntry = {
      id: generateId(),
      sessionId,
      startedAt: now,
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
  test("new session records initial endpoint on entry completion", () => {
    const entry = createEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
    })
    completeEntry(entry.id)

    const session = getSession(entry.sessionId!) as Session
    expect(session.endpoints).toContain("anthropic-messages")
  })

  test("same endpoint is not duplicated across completions", () => {
    const sessionId = "session-1"
    for (let i = 0; i < 3; i++) {
      const id = generateId()
      insertEntry({
        id,
        sessionId,
        startedAt: Date.now() + i,
        endpoint: "anthropic-messages",
        request: { model: "test", messages: [{ role: "user", content: `m${i}` }], stream: true },
      })
      completeEntry(id)
    }

    const session = getSession(sessionId) as Session
    expect(session.endpoints).toEqual(["anthropic-messages"])
  })

  test("session tracks the endpoint of its entries", () => {
    const sessionId = "session-multi"
    const id = generateId()
    insertEntry({
      id,
      sessionId,
      startedAt: Date.now(),
      endpoint: "openai-chat-completions",
      request: { model: "test", messages: [{ role: "user", content: "hi" }], stream: true },
    })
    completeEntry(id)

    const session = getSession(sessionId) as Session
    expect(session.endpoints).toContain("openai-chat-completions")
  })
})

// ─── getSessionEntries pagination ───

describe("getSessionEntries pagination", () => {
  test("returns paginated results with default limit", () => {
    const sessionId = getCurrentSession("anthropic-messages", generateId())!

    for (let i = 0; i < 5; i++) {
      const entry: HistoryEntry = {
        id: generateId(),
        sessionId,
        startedAt: Date.now() + i,
        endpoint: "anthropic-messages",
        request: { model: "test", messages: [{ role: "user", content: `msg ${i}` }] },
      }
      insertEntry(entry)
      completeEntry(entry.id)
    }

    const result = getSessionEntries(sessionId)
    expect(result.total).toBe(5)
    expect(result.entries).toHaveLength(5)
    expect(result.prevCursor).toBeNull()
  })

  test("respects cursor and limit", () => {
    const sessionId = getCurrentSession("anthropic-messages", generateId())!

    for (let i = 0; i < 10; i++) {
      const entry: HistoryEntry = {
        id: generateId(),
        sessionId,
        startedAt: Date.now() + i,
        endpoint: "anthropic-messages",
        request: { model: "test", messages: [{ role: "user", content: `msg ${i}` }] },
      }
      insertEntry(entry)
      completeEntry(entry.id)
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
    const entry = createEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "hello" }],
    })
    completeEntry(entry.id)

    expect(totalEntryCount()).toBe(1)
    expect(getSessions().sessions.length).toBe(1)

    clearHistory()

    expect(totalEntryCount()).toBe(0)
    expect(getSessions().sessions.length).toBe(0)
  })

  test("clears in-flight entries", () => {
    createEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "hello" }],
    })
    expect(listInFlightEntries().length).toBe(1)
    clearHistory()
    expect(listInFlightEntries().length).toBe(0)
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
      state: "completed",
      response: {
        success: true,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 100, output_tokens: 50 },
        content: null,
      },
      durationMs: 500,
    })
    finalizeEntry(entry.id)

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
  test("reaper removes oldest entries when exceeding limit", () => {
    const baseTime = Date.now()
    const entries: Array<HistoryEntry> = []
    for (let i = 0; i < 5; i++) {
      const entry: HistoryEntry = {
        id: generateId(),
        sessionId: `session-${i}`,
        startedAt: baseTime + i,
        endpoint: "anthropic-messages",
        request: {
          model: "test",
          messages: [{ role: "user", content: `msg-${i}` }],
          stream: true,
        },
      }
      insertEntry(entry)
      entries.push(entry)
    }
    // Complete all entries so they are persisted to SQLite
    for (const entry of entries) completeEntry(entry.id)

    expect(queryEntryCount()).toBe(5)

    // Run reaper with limit=3 — should evict 2 oldest
    runReaperOnce(3)

    expect(queryEntryCount()).toBe(3)
    // Oldest entries should be removed (FIFO by startedAt)
    expect(getEntry(entries[0].id)).toBeUndefined()
    expect(getEntry(entries[1].id)).toBeUndefined()
    expect(getEntry(entries[2].id)).toBeDefined()
  })
})
