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
  HistoryEntry,
} from "~/lib/history"

import {
  //
  clearHistory,
  getCurrentSession,
  getEntry,
  getHistory,
  getSessionEntries,
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

import { insertHistoryEntry } from "../helpers/history-fixtures"
import { autoRestoreState } from "../helpers/state-fixture"

/** Mark an entry as completed so session stats are persisted to SQLite. */
async function completeEntry(entryId: string, overrides: Partial<Parameters<typeof updateEntry>[1]> = {}): Promise<void> {
  updateEntry(entryId, {
    state: "completed",
    attempts: [
      {
        index: 0,
        strategy: "primary",
        durationMs: 0,
        upstreamResponse: {
          success: true,
          model: "test-model",
          usage: { input_tokens: 0, output_tokens: 0 },
          body: null,
        },
      },
    ],
    _index: { derived: { responseSuccess: true, attemptCount: 1, currentStrategy: "primary" } },
    ...overrides,
  })
  // updateEntry no longer auto-persists on terminal state — the explicit
  // finalizeEntry call mirrors the consumer pipeline behavior.
  await finalizeEntry(entryId)
}

/** Count persisted + in-flight entries. */
function totalEntryCount(): number {
  try {
    return queryEntryCount() + listInFlightEntries().length
  } catch {
    return listInFlightEntries().length
  }
}

// Snapshot global state once and restore after every test so per-test mutations
// (e.g. raw-capture config) can't leak into other test files.
autoRestoreState()

// Reset history state before each test
beforeEach(async () => {
  setStateForTests({ historyDbPath: ":memory:" })
  initHistory(true, 200)
})

afterEach(async () => {
  clearHistory()
  await shutdownHistory()
  setStateForTests({ historyDbPath: "" })
})

// ─── initHistory ───

describe("initHistory", () => {
  test("enables history when enabled=true", async () => {
    initHistory(true, 100)
    expect(isHistoryEnabled()).toBe(true)
  })

  test("disables history when enabled=false", async () => {
    initHistory(false, 100)
    expect(isHistoryEnabled()).toBe(false)
  })

  test("tracks history limit from state", async () => {
    setStateForTests({ historyRawCaptureMaxObjectBytes: 50 })
    initHistory(true, 50)
    expect(state.historyRawCaptureMaxObjectBytes).toBe(50)
  })

  test("resets entries and sessions", async () => {
    // Add some data first
    insertHistoryEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "test" }],
    })
    expect(totalEntryCount()).toBe(1)

    // clearHistory should clear everything
    clearHistory()
    expect(totalEntryCount()).toBe(0)
  })
})

// ─── insertEntry ───

describe("insertEntry", () => {
  test("inserts entry and makes it retrievable", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    })

    expect(entry.id).toBeTruthy()
    expect(typeof entry.id).toBe("string")
    expect(getEntry(entry.id)).toBeDefined()
  })

  test("does not insert when disabled", async () => {
    initHistory(false, 100)
    const sessionId = "test-session"
    const entry: HistoryEntry = {
      id: generateId(),
      sessionId,
      startedAt: Date.now(),
      endpoint: "anthropic-messages",
      model: { requested: "claude-sonnet-4-20250514" },
      clientRequest: {
        format: "anthropic-messages",
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
    }
    insertEntry(entry)
    expect(listInFlightEntries().length).toBe(0)
  })

  test("creates entry with correct fields", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
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
    expect(stored!.clientRequest?.model).toBe("claude-sonnet-4-20250514")
    expect(stored!.clientRequest?.messages).toHaveLength(1)
    expect(stored!.clientRequest?.stream).toBe(true)
    expect(stored!.clientRequest?.system).toBe("You are helpful")
    expect(stored!.clientRequest?.max_tokens).toBe(1024)
    expect(stored!.clientRequest?.temperature).toBe(0.5)
    expect(stored!.clientRequest?.tools).toHaveLength(1)
    expect(stored!.attempts).toBeUndefined()
  })

  test("keeps an explicit sessionId on the entry", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "test" }],
    })

    expect(entry.sessionId).toBeTruthy()
  })

  test("stores entries without a session when none is provided", async () => {
    const entry: HistoryEntry = {
      id: generateId(),
      startedAt: Date.now(),
      endpoint: "anthropic-messages",
      model: { requested: "claude-sonnet-4-20250514" },
      clientRequest: {
        format: "anthropic-messages",
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "no session" }],
        stream: true,
      },
    }

    insertEntry(entry)

    const stored = getEntry(entry.id)
    expect(stored?.sessionId).toBeUndefined()
  })
})

// ─── updateEntry (response) ───

describe("updateEntry (response)", () => {
  test("updates entry with response data", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    })

    updateEntry(entry.id, {
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "claude-sonnet-4-20250514",
            usage: { input_tokens: 100, output_tokens: 50 },
            stopReason: "end_turn",
            body: { role: "assistant", content: "Hi there" },
          },
        },
      ],
      durationMs: 500,
    })

    const stored = getEntry(entry.id)
    const resp = stored!.attempts?.at(-1)?.upstreamResponse
    expect(resp).toBeDefined()
    expect(resp!.success).toBe(true)
    expect(resp!.model).toBe("claude-sonnet-4-20250514")
    expect(resp!.usage!.input_tokens).toBe(100)
    expect(resp!.usage!.output_tokens).toBe(50)
    expect(resp!.stopReason).toBe("end_turn")
    expect(stored!.durationMs).toBe(500)
  })

  test("preserves cache_creation_input_tokens in usage", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    })

    updateEntry(entry.id, {
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "claude-sonnet-4-20250514",
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_read_input_tokens: 80,
              cache_creation_input_tokens: 20,
            },
            stopReason: "end_turn",
            body: null,
          },
        },
      ],
    })

    const stored = getEntry(entry.id)
    const usage = stored!.attempts?.at(-1)?.upstreamResponse?.usage
    expect(usage!.cache_read_input_tokens).toBe(80)
    expect(usage!.cache_creation_input_tokens).toBe(20)
  })

  test("records error response", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    })

    updateEntry(entry.id, {
      attempts: [
        {
          index: 0,
          durationMs: 0,
          error: "Rate limited",
          upstreamResponse: {
            success: false,
            model: "claude-sonnet-4-20250514",
            usage: { input_tokens: 0, output_tokens: 0 },
            body: null,
          },
        },
      ],
      _index: { derived: { responseSuccess: false, failureReason: "Rate limited", attemptCount: 1 } },
      durationMs: 100,
    })

    const stored = getEntry(entry.id)
    expect(stored!.attempts?.at(-1)?.upstreamResponse?.success).toBe(false)
    expect(stored!.attempts?.at(-1)?.error).toBe("Rate limited")
  })

  test("does nothing when disabled", async () => {
    initHistory(false, 100)
    updateEntry("nonexistent", {
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "test",
            usage: { input_tokens: 0, output_tokens: 0 },
            body: null,
          },
        },
      ],
    })
    // Should not throw
  })
})

// ─── updateEntry (rewrites) ───

describe("updateEntry (rewrites)", () => {
  test("adds rewrite info to entry", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
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
            emptyThinkingBlocksRemoved: 0,
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

  test("stores truncation within pipelineInfo", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
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

  test("stores effectiveSource + upstreamRequest via updateEntry", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    })

    updateEntry(entry.id, {
      attempts: [
        {
          index: 0,
          durationMs: 0,
          effectiveSource: {
            model: "claude-sonnet-4-20250514",
            format: "anthropic-messages",
            messageCount: 1,
            messages: [{ role: "user", content: "truncated" }],
            body: {
              model: "claude-sonnet-4-20250514",
              messages: [{ role: "user", content: "truncated" }],
              max_tokens: 4096,
            },
          },
          upstreamRequest: {
            model: "claude-sonnet-4-20250514",
            format: "anthropic-messages",
            messages: [{ role: "user", content: "truncated" }],
            headers: { "x-request-id": "abc" },
            body: {
              model: "claude-sonnet-4-20250514",
              messages: [{ role: "user", content: "truncated" }],
              max_tokens: 4096,
              stream: true,
            },
          },
        },
      ],
    })

    const stored = getEntry(entry.id)
    const attempt = stored!.attempts?.at(-1)
    expect(attempt?.effectiveSource).toBeDefined()
    expect(attempt!.effectiveSource!.model).toBe("claude-sonnet-4-20250514")
    expect(attempt!.effectiveSource!.messageCount).toBe(1)
    expect(attempt!.effectiveSource!.body).toEqual({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "truncated" }],
      max_tokens: 4096,
    })
    expect(attempt!.upstreamRequest).toEqual({
      model: "claude-sonnet-4-20250514",
      format: "anthropic-messages",
      messages: [{ role: "user", content: "truncated" }],
      headers: { "x-request-id": "abc" },
      body: {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "truncated" }],
        max_tokens: 4096,
        stream: true,
      },
    })
    expect(attempt!.upstreamRequest!.headers).toEqual({ "x-request-id": "abc" })
  })

  test("stores attempts via updateEntry", async () => {
    const entry = insertHistoryEntry("anthropic-messages", { model: "m", messages: undefined })

    updateEntry(entry.id, {
      attempts: [
        { index: 0, durationMs: 100, effectiveSource: { messageCount: 10 } },
        { index: 1, strategy: "auto-truncate", durationMs: 200, effectiveSource: { messageCount: 5 } },
      ],
    })

    const stored = getEntry(entry.id)
    expect(stored!.attempts).toHaveLength(2)
    expect(stored!.attempts![1].strategy).toBe("auto-truncate")
    expect(stored!.attempts![1].effectiveSource!.messageCount).toBe(5)
  })

  test("stores transport via updateEntry", async () => {
    const entry = insertHistoryEntry("openai-responses", {
      model: "gpt-5.2",
      messages: [{ role: "user", content: "hello" }],
    })

    updateEntry(entry.id, {
      transport: "upstream-ws-fallback",
    })

    const stored = getEntry(entry.id)
    expect(stored!.transport).toBe("upstream-ws-fallback")
  })

  test("stores warningMessages via updateEntry", async () => {
    const entry = insertHistoryEntry("openai-chat-completions", {
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

  test("stores response with status, rawBody, and headers", async () => {
    const entry = insertHistoryEntry("anthropic-messages", { model: "m", messages: undefined })

    updateEntry(entry.id, {
      attempts: [
        {
          index: 0,
          durationMs: 0,
          error: "Bad request",
          upstreamResponse: {
            success: false,
            model: "claude-sonnet-4",
            usage: { input_tokens: 0, output_tokens: 0 },
            status: 400,
            body: null,
            rawBody: '{"error":"thinking blocks cannot be modified"}',
            headers: { "x-request-id": "xyz" },
          },
        },
      ],
      _index: { derived: { responseSuccess: false, failureReason: "Bad request", attemptCount: 1 } },
    })

    const stored = getEntry(entry.id)
    const resp = stored!.attempts?.at(-1)?.upstreamResponse
    expect(resp!.status).toBe(400)
    expect(resp!.rawBody).toBe('{"error":"thinking blocks cannot be modified"}')
    expect(resp!.headers).toEqual({ "x-request-id": "xyz" })
  })
})

// ─── getHistory ───

describe("getHistory", () => {
  test("returns entries sorted by startedAt descending", async () => {
    insertHistoryEntry("anthropic-messages", {
      model: "model-a",
      messages: [{ role: "user", content: "first" }],
    })
    insertHistoryEntry("anthropic-messages", {
      model: "model-b",
      messages: [{ role: "user", content: "second" }],
    })

    const result = getHistory()
    expect(result.entries.length).toBe(2)
    expect(result.entries[0].startedAt).toBeGreaterThanOrEqual(result.entries[1].startedAt)
  })

  test("paginates results", async () => {
    for (let i = 0; i < 5; i++) {
      insertHistoryEntry("anthropic-messages", {
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

  test("filters by model name", async () => {
    insertHistoryEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "a" }],
    })
    insertHistoryEntry("anthropic-messages", {
      model: "gpt-4o",
      messages: [{ role: "user", content: "b" }],
    })

    const result = getHistory({ model: "claude" })
    expect(result.total).toBe(1)
    expect(result.entries[0].clientRequest?.model).toContain("claude")
  })

  test("filters by endpoint", async () => {
    insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "a" }],
    })
    insertHistoryEntry("openai-chat-completions", {
      model: "test",
      messages: [{ role: "user", content: "b" }],
    })

    const result = getHistory({ endpoint: "openai-chat-completions" })
    expect(result.total).toBe(1)
    expect(result.entries[0].endpoint).toBe("openai-chat-completions")
  })

  test("filters by startedAt range (to)", async () => {
    const now = Date.now()
    const sessionId = getCurrentSession("anthropic-messages", generateId())!

    const old: HistoryEntry = {
      id: generateId(),
      sessionId,
      startedAt: now - 10000,
      endpoint: "anthropic-messages",
      model: { requested: "test" },
      clientRequest: { format: "anthropic-messages", model: "test", messages: [{ role: "user", content: "old" }], stream: true },
    }
    insertEntry(old)

    const recent: HistoryEntry = {
      id: generateId(),
      sessionId,
      startedAt: now,
      endpoint: "anthropic-messages",
      model: { requested: "test" },
      clientRequest: { format: "anthropic-messages", model: "test", messages: [{ role: "user", content: "new" }], stream: true },
    }
    insertEntry(recent)

    const result = getHistory({ to: now - 5000 })
    expect(result.total).toBe(1)
    expect(result.entries[0].id).toBe(old.id)
  })

  test("filters by startedAt range (from + to)", async () => {
    const now = Date.now()
    const sessionId = getCurrentSession("anthropic-messages", generateId())!

    const old: HistoryEntry = {
      id: generateId(),
      sessionId,
      startedAt: now - 20000,
      endpoint: "anthropic-messages",
      model: { requested: "test" },
      clientRequest: { format: "anthropic-messages", model: "test", messages: [{ role: "user", content: "old" }], stream: true },
    }
    insertEntry(old)

    const mid: HistoryEntry = {
      id: generateId(),
      sessionId,
      startedAt: now - 10000,
      endpoint: "anthropic-messages",
      model: { requested: "test" },
      clientRequest: { format: "anthropic-messages", model: "test", messages: [{ role: "user", content: "mid" }], stream: true },
    }
    insertEntry(mid)

    const recent: HistoryEntry = {
      id: generateId(),
      sessionId,
      startedAt: now,
      endpoint: "anthropic-messages",
      model: { requested: "test" },
      clientRequest: { format: "anthropic-messages", model: "test", messages: [{ role: "user", content: "new" }], stream: true },
    }
    insertEntry(recent)

    const result = getHistory({ from: now - 15000, to: now - 5000 })
    expect(result.total).toBe(1)
    expect(result.entries[0].id).toBe(mid.id)
  })
})

// ─── updateEntry: sseEvents ───

describe("updateEntry stores sseEvents", () => {
  test("sseEvents are persisted via updateEntry", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
    })

    const sseEvents = [
      { offsetMs: 0, type: "message_start", raw: JSON.stringify({ type: "message_start" }) },
      { offsetMs: 50, type: "content_block_delta", raw: JSON.stringify({ type: "content_block_delta" }) },
      { offsetMs: 100, type: "message_stop", raw: JSON.stringify({ type: "message_stop" }) },
    ]

    updateEntry(entry.id, {
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: { success: true, model: "test", usage: { input_tokens: 0, output_tokens: 0 }, body: null, sseEvents },
        },
      ],
    })

    const updated = getEntry(entry.id)
    const stored = updated?.attempts?.at(-1)?.upstreamResponse?.sseEvents
    expect(stored).toEqual(sseEvents)
    expect(stored).toHaveLength(3)
  })

  test("sseEvents can be set alongside response", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
    })

    updateEntry(entry.id, {
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "test",
            usage: { input_tokens: 10, output_tokens: 5 },
            body: null,
            sseEvents: [{ offsetMs: 0, type: "message_start", raw: "{}" }],
          },
        },
      ],
      durationMs: 100,
    })

    const updated = getEntry(entry.id)
    expect(updated?.attempts?.at(-1)?.upstreamResponse?.success).toBe(true)
    expect(updated?.attempts?.at(-1)?.upstreamResponse?.sseEvents).toHaveLength(1)
    expect(updated?.durationMs).toBe(100)
  })
})

// ─── getSessionEntries pagination ───

describe("getSessionEntries pagination", () => {
  test("returns paginated results with default limit", async () => {
    const sessionId = getCurrentSession("anthropic-messages", generateId())!

    for (let i = 0; i < 5; i++) {
      const entry: HistoryEntry = {
        id: generateId(),
        sessionId,
        startedAt: Date.now() + i,
        endpoint: "anthropic-messages",
        model: { requested: "test" },
        clientRequest: { format: "anthropic-messages", model: "test", messages: [{ role: "user", content: `msg ${i}` }] },
      }
      insertEntry(entry)
      await completeEntry(entry.id)
    }

    const result = getSessionEntries(sessionId)
    expect(result.total).toBe(5)
    expect(result.entries).toHaveLength(5)
    expect(result.prevCursor).toBeNull()
  })

  test("respects cursor and limit", async () => {
    const sessionId = getCurrentSession("anthropic-messages", generateId())!

    for (let i = 0; i < 10; i++) {
      const entry: HistoryEntry = {
        id: generateId(),
        sessionId,
        startedAt: Date.now() + i,
        endpoint: "anthropic-messages",
        model: { requested: "test" },
        clientRequest: { format: "anthropic-messages", model: "test", messages: [{ role: "user", content: `msg ${i}` }] },
      }
      insertEntry(entry)
      await completeEntry(entry.id)
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

  test("returns empty for non-existent session", async () => {
    const result = getSessionEntries("nonexistent")
    expect(result.total).toBe(0)
    expect(result.entries).toHaveLength(0)
  })
})

// ─── clearHistory ───

describe("clearHistory", () => {
  test("removes all entries", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "hello" }],
    })
    await completeEntry(entry.id)

    expect(totalEntryCount()).toBe(1)

    clearHistory()

    expect(totalEntryCount()).toBe(0)
  })

  test("clears in-flight entries", async () => {
    insertHistoryEntry("anthropic-messages", {
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
  test("returns aggregate statistics", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    })

    updateEntry(entry.id, {
      state: "completed",
      attempts: [
        {
          index: 0,
          strategy: "primary",
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "claude-sonnet-4-20250514",
            usage: { input_tokens: 100, output_tokens: 50 },
            body: null,
          },
        },
      ],
      _index: { derived: { responseSuccess: true, attemptCount: 1, currentStrategy: "primary" } },
      durationMs: 500,
    })
    await finalizeEntry(entry.id)

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
  test("reaper removes oldest entries when exceeding limit", async () => {
    const baseTime = Date.now()
    const entries: Array<HistoryEntry> = []
    for (let i = 0; i < 5; i++) {
      const entry: HistoryEntry = {
        id: generateId(),
        sessionId: `session-${i}`,
        startedAt: baseTime + i,
        endpoint: "anthropic-messages",
        model: { requested: "test" },
        clientRequest: {
          format: "anthropic-messages",
          model: "test",
          messages: [{ role: "user", content: `msg-${i}` }],
          stream: true,
        },
      }
      insertEntry(entry)
      entries.push(entry)
    }
    // Complete all entries so they are persisted to SQLite
    for (const entry of entries) await completeEntry(entry.id)

    expect(queryEntryCount()).toBe(5)

    // Run reaper with success-limit=3 — should evict 2 oldest successes
    runReaperOnce(3, 0)

    expect(queryEntryCount()).toBe(3)
    // Oldest entries should be removed (FIFO by startedAt)
    expect(getEntry(entries[0].id)).toBeUndefined()
    expect(getEntry(entries[1].id)).toBeUndefined()
    expect(getEntry(entries[2].id)).toBeDefined()
  })
})
