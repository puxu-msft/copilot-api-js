/**
 * Tests for the EntrySummary layer: toSummary, getSummary, getHistorySummaries.
 *
 * Covers:
 * - Summary correctness (fields, previewText)
 * - getSummary lookup
 * - getHistorySummaries filtering, pagination, search
 * - updateEntry({request}) path (originalRequest timing fix)
 * - Summary cache consistency across insert/update/eviction/clear
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
  EntrySummary,
  HistoryEntry,
} from "~/lib/history"

import {
  //
  clearHistory,
  getCurrentSession,
  getHistorySummaries,
  getSummary,
  initHistory,
  insertEntry,
  shutdownHistory,
  updateEntry,
} from "~/lib/history"
import { setStateForTests } from "~/lib/state"
import { generateId } from "~/lib/utils"

import { insertHistoryEntry } from "../helpers/history-fixtures"

// ─── Helpers ───

/** Create an entry with empty request (simulates context "created" event timing) */
function createEmptyEntry(endpoint: EndpointType): HistoryEntry {
  const sessionId = getCurrentSession(endpoint, generateId())
  const entry: HistoryEntry = {
    id: generateId(),
    sessionId,
    startedAt: Date.now(),
    endpoint,
    clientRequest: {
      format: endpoint,
      model: undefined,
      messages: undefined,
      stream: undefined,
    },
  }
  insertEntry(entry)
  return entry
}

beforeEach(async () => {
  setStateForTests({ historyDbPath: ":memory:" })
  await initHistory(true, 200)
})

afterEach(async () => {
  clearHistory()
  await shutdownHistory()
  setStateForTests({ historyDbPath: "" })
})

// ─── Summary correctness ───

describe("summary correctness (toSummary)", () => {
  test("basic fields are copied from entry", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    })

    const summary = getSummary(entry.id)
    expect(summary).toBeDefined()
    expect(summary!.id).toBe(entry.id)
    expect(summary!.sessionId).toBe(entry.sessionId)
    expect(summary!.startedAt).toBe(entry.startedAt)
    expect(summary!.endpoint).toBe("anthropic-messages")
    expect(summary!.requestModel).toBe("claude-sonnet-4-20250514")
    expect(summary!.stream).toBe(true)
    expect(summary!.messageCount).toBe(1)
  })

  test("previewText extracts last user message content (string)", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "follow-up question" },
      ],
    })

    const summary = getSummary(entry.id)!
    expect(summary.previewText).toBe("follow-up question")
  })

  test("previewText extracts from content blocks", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "block-based content" }],
        },
      ],
    })

    const summary = getSummary(entry.id)!
    expect(summary.previewText).toBe("block-based content")
  })

  test("previewText truncates at 100 characters", async () => {
    const longText = "a".repeat(200)
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: longText }],
    })

    const summary = getSummary(entry.id)!
    expect(summary.previewText).toHaveLength(100)
  })

  test("previewText is empty when no messages", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [],
    })

    const summary = getSummary(entry.id)!
    expect(summary.previewText).toBe("")
  })

  test("previewText faithfully summarizes the last message when it is an OpenAI tool response (role=tool)", async () => {
    const entry = insertHistoryEntry("openai-chat-completions", {
      model: "gpt-4o",
      messages: [
        { role: "user", content: "What is 2+2?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "calculator", arguments: '{"expr":"2+2"}' } }],
        } as any,
        { role: "tool", content: "4", tool_call_id: "call_1" } as any,
      ],
    })

    const summary = getSummary(entry.id)!
    // Last message is the tool result — show it faithfully (NOT hunt back to the user message).
    expect(summary.previewText).toBe("[tool_result: call_1]")
  })

  test("previewText shows tool_call name when only assistant tool_calls remain", async () => {
    const entry = insertHistoryEntry("openai-chat-completions", {
      model: "gpt-4o",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }],
        } as any,
      ],
    })

    const summary = getSummary(entry.id)!
    expect(summary.previewText).toContain("tool_call")
    expect(summary.previewText).toContain("web_search")
  })

  test("previewText shows tool_result when last message is role=tool", async () => {
    const entry = insertHistoryEntry("openai-chat-completions", {
      model: "gpt-4o",
      messages: [{ role: "tool", content: "result data", tool_call_id: "call_1" } as any],
    })

    const summary = getSummary(entry.id)!
    expect(summary.previewText).toContain("tool_result")
    expect(summary.previewText).toContain("call_1")
  })

  test("previewText faithfully shows the last message when it is a user message with only tool_result blocks", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "Analyze this code" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents..." }] },
      ],
    })

    const summary = getSummary(entry.id)!
    // Last message is the tool_result — show it faithfully (NOT hunt back to "Analyze this code").
    expect(summary.previewText).toBe("[tool_result: t1]")
  })

  test("previewText for openai-responses endpoint", async () => {
    const entry = insertHistoryEntry("openai-responses", {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello from Responses API" }],
    })

    const summary = getSummary(entry.id)!
    expect(summary.previewText).toBe("Hello from Responses API")
  })

  test("list free-text search no longer matches the model name (use the model filter)", async () => {
    insertHistoryEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    })

    // RFC v5: list search is message/preview-only. The model is a structural
    // filter, not a free-text dimension.
    expect(getHistorySummaries({ search: "claude-sonnet-4-20250514" }).entries).toHaveLength(0)
    expect(getHistorySummaries({ model: "claude-sonnet-4-20250514" }).entries).toHaveLength(1)
  })

  test("search finds entries by message content", async () => {
    insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "find the unique phrase" }],
    })

    const results = getHistorySummaries({ search: "find the unique phrase" })
    expect(results.entries).toHaveLength(1)
  })

  test("list free-text search does NOT match the system prompt (intentionally excluded)", async () => {
    insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
      system: "You are a helpful coding assistant",
    })

    // RFC: the inbound index covers message blocks only, never the system prompt.
    const results = getHistorySummaries({ search: "helpful coding assistant" })
    expect(results.entries).toHaveLength(0)
  })

  test("search finds entries by tool_use names from content blocks", async () => {
    insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "web_search", input: {} }],
        },
      ],
    })

    const results = getHistorySummaries({ search: "web_search" })
    expect(results.entries).toHaveLength(1)
  })

  test("search finds entries by OpenAI tool_calls function names", async () => {
    insertHistoryEntry("openai-chat-completions", {
      model: "gpt-4o",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "calculator", arguments: "{}" } }],
        } as any,
      ],
    })

    const results = getHistorySummaries({ search: "calculator" })
    expect(results.entries).toHaveLength(1)
  })

  test("search is case-insensitive", async () => {
    insertHistoryEntry("anthropic-messages", {
      model: "Claude-Sonnet",
      messages: [{ role: "user", content: "HELLO WORLD" }],
    })

    // Search with lowercase should find uppercase content
    const results = getHistorySummaries({ search: "hello world" })
    expect(results.entries).toHaveLength(1)
  })

  test("response fields are undefined before updateEntry", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "hello" }],
    })

    const summary = getSummary(entry.id)!
    expect(summary.responseModel).toBeUndefined()
    expect(summary.responseSuccess).toBeUndefined()
    expect(summary.responseError).toBeUndefined()
    expect(summary.usage).toBeUndefined()
    expect(summary.durationMs).toBeUndefined()
  })

  test("response fields are populated after updateEntry", async () => {
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
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 30 },
            stopReason: "end_turn",
            body: { role: "assistant", content: "Hi" },
          },
        },
      ],
      _index: { derived: { responseSuccess: true, attemptCount: 1 } },
      durationMs: 250,
    })

    const summary = getSummary(entry.id)!
    expect(summary.responseModel).toBe("claude-sonnet-4-20250514")
    expect(summary.responseSuccess).toBe(true)
    expect(summary.responseError).toBeUndefined()
    expect(summary.usage).toEqual({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 30 })
    expect(summary.durationMs).toBe(250)
  })

  test("error response populates responseError", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "test",
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
            model: "test",
            usage: { input_tokens: 10, output_tokens: 0 },
            body: null,
          },
        },
      ],
      _index: { derived: { responseSuccess: false, failureReason: "Rate limited", attemptCount: 1 } },
    })

    const summary = getSummary(entry.id)!
    expect(summary.responseSuccess).toBe(false)
    expect(summary.responseError).toBe("Rate limited")
  })
})

// ─── updateEntry with request field ───

describe("updateEntry (request)", () => {
  test("updates request data and rebuilds summary", async () => {
    // Simulate context timing: insertEntry with empty request, then update with real data
    const entry = createEmptyEntry("anthropic-messages")

    // Initial summary has empty data
    const before = getSummary(entry.id)!
    expect(before.requestModel).toBeUndefined()
    expect(before.messageCount).toBe(0)
    expect(before.previewText).toBe("")

    // Update with actual request data (as consumers.ts does for originalRequest)
    updateEntry(entry.id, {
      model: { requested: "claude-sonnet-4-20250514" },
      clientRequest: {
        format: "anthropic-messages",
        model: "claude-sonnet-4-20250514",
        messages: [
          { role: "user", content: "What is 2+2?" },
          { role: "assistant", content: "4" },
          { role: "user", content: "Thanks" },
        ],
        stream: true,
        tools: [{ name: "calculator", description: "Math tool" }],
        system: "Be concise",
      },
    })

    // Summary should now reflect the actual data
    const after = getSummary(entry.id)!
    expect(after.requestModel).toBe("claude-sonnet-4-20250514")
    expect(after.stream).toBe(true)
    expect(after.messageCount).toBe(3)
    expect(after.previewText).toBe("Thanks")

    // List search matches MESSAGE content; the model uses the structural filter;
    // the system prompt is intentionally excluded from the index.
    expect(getHistorySummaries({ model: "claude-sonnet-4-20250514" }).entries).toHaveLength(1)
    expect(getHistorySummaries({ search: "what is 2+2" }).entries).toHaveLength(1)
    expect(getHistorySummaries({ search: "be concise" }).entries).toHaveLength(0)
  })

  test("full lifecycle: empty insert → request update → response update", async () => {
    const entry = createEmptyEntry("anthropic-messages")

    // Step 1: Verify empty summary
    expect(getSummary(entry.id)!.requestModel).toBeUndefined()

    // Step 2: Update with request
    updateEntry(entry.id, {
      model: { requested: "claude-sonnet-4-20250514" },
      clientRequest: {
        format: "anthropic-messages",
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
    })
    const afterRequest = getSummary(entry.id)!
    expect(afterRequest.requestModel).toBe("claude-sonnet-4-20250514")
    expect(afterRequest.stream).toBe(false)
    expect(afterRequest.responseSuccess).toBeUndefined()

    // Step 3: Update with response
    updateEntry(entry.id, {
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "claude-sonnet-4-20250514",
            usage: { input_tokens: 50, output_tokens: 25 },
            stopReason: "end_turn",
            body: { role: "assistant", content: "Hi there!" },
          },
        },
      ],
      _index: { derived: { responseSuccess: true, attemptCount: 1 } },
      durationMs: 300,
    })
    const afterResponse = getSummary(entry.id)!
    expect(afterResponse.requestModel).toBe("claude-sonnet-4-20250514")
    expect(afterResponse.responseSuccess).toBe(true)
    expect(afterResponse.durationMs).toBe(300)
    expect(afterResponse.usage).toEqual({ input_tokens: 50, output_tokens: 25 })
  })
})

// ─── getHistorySummaries ───

describe("getHistorySummaries", () => {
  test("returns summaries sorted by startedAt descending", async () => {
    insertHistoryEntry("anthropic-messages", {
      model: "model-a",
      messages: [{ role: "user", content: "first" }],
    })
    insertHistoryEntry("anthropic-messages", {
      model: "model-b",
      messages: [{ role: "user", content: "second" }],
    })

    const result = getHistorySummaries()
    expect(result.entries.length).toBe(2)
    expect(result.entries[0].startedAt).toBeGreaterThanOrEqual(result.entries[1].startedAt)
  })

  test("paginates results", async () => {
    for (let i = 0; i < 5; i++) {
      insertHistoryEntry("anthropic-messages", {
        model: "test",
        messages: [{ role: "user", content: `msg-${i}` }],
      })
    }

    // First page: no cursor
    const page1 = getHistorySummaries({ limit: 2 })
    expect(page1.entries.length).toBe(2)
    expect(page1.total).toBe(5)
    expect(page1.nextCursor).not.toBeNull()
    expect(page1.prevCursor).toBeNull()

    // Second page: use last entry's ID as cursor
    const page2 = getHistorySummaries({ cursor: page1.entries.at(-1)!.id, limit: 2 })
    expect(page2.entries.length).toBe(2)

    // Third (last) page
    const page3 = getHistorySummaries({ cursor: page2.entries.at(-1)!.id, limit: 2 })
    expect(page3.entries.length).toBe(1)
    expect(page3.nextCursor).toBeNull()
  })

  test("filters by model name (partial, case-insensitive)", async () => {
    insertHistoryEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "a" }],
    })
    insertHistoryEntry("anthropic-messages", {
      model: "gpt-4o",
      messages: [{ role: "user", content: "b" }],
    })

    const result = getHistorySummaries({ model: "claude" })
    expect(result.total).toBe(1)
    expect(result.entries[0].requestModel).toContain("claude")
  })

  test("model filter matches response model too", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "a" }],
    })
    updateEntry(entry.id, {
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "claude-sonnet-4-20250514-v2",
            usage: { input_tokens: 10, output_tokens: 5 },
            body: null,
          },
        },
      ],
      _index: { derived: { responseSuccess: true, attemptCount: 1 } },
    })

    const result = getHistorySummaries({ model: "v2" })
    expect(result.total).toBe(1)
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

    const result = getHistorySummaries({ endpoint: "openai-chat-completions" })
    expect(result.total).toBe(1)
    expect(result.entries[0].endpoint).toBe("openai-chat-completions")
  })

  test("terminalOnly excludes active in-flight (streaming) entries but keeps terminal ones", async () => {
    // Terminal entry (no active flag → treated as terminal).
    const done = insertHistoryEntry("anthropic-messages", {
      model: "done-model",
      messages: [{ role: "user", content: "done" }],
    })
    // Active in-flight streaming entry (mirrors what the Live lane shows).
    const live: HistoryEntry = {
      id: generateId(),
      startedAt: Date.now() + 1,
      endpoint: "anthropic-messages",
      state: "streaming",
      active: true,
      model: { requested: "live-model" },
      clientRequest: { format: "anthropic-messages", model: "live-model", messages: [{ role: "user", content: "live" }], stream: true },
    }
    insertEntry(live)

    // Default: both returned (richest data — v3 combined activity view).
    const all = getHistorySummaries()
    expect(all.entries.map((e) => e.id).sort()).toEqual([done.id, live.id].sort())

    // terminalOnly: the active in-flight entry is excluded, total reflects it.
    const terminal = getHistorySummaries({ terminalOnly: true })
    expect(terminal.entries.map((e) => e.id)).toEqual([done.id])
    expect(terminal.total).toBe(1)
  })

  test("V3 summaries ignore a retired V2 eager streaming head row", async () => {
    // V3 list reads only canonical terminal operations. The legacy eager-row
    // helper remains a test seam during cutover but must not leak into V3 list.
    const done = insertHistoryEntry("anthropic-messages", {
      model: "done-model",
      messages: [{ role: "user", content: "done" }],
    })
    const streamingRow: HistoryEntry = {
      id: generateId(),
      startedAt: Date.now() + 1,
      endpoint: "anthropic-messages",
      state: "streaming",
      active: true,
      model: { requested: "live-model" },
      clientRequest: { format: "anthropic-messages", model: "live-model", messages: [{ role: "user", content: "live" }], stream: true },
    }
    insertEntry(streamingRow)

    const all = getHistorySummaries()
    expect(all.entries.map((e) => e.id).sort()).toEqual([done.id, streamingRow.id].sort())

    const terminal = getHistorySummaries({ terminalOnly: true })
    expect(terminal.entries.map((e) => e.id)).toEqual([done.id])
    expect(terminal.total).toBe(1)
  })

  test("filters by success status", async () => {
    const e1 = insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "a" }],
    })
    const e2 = insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "b" }],
    })
    updateEntry(e1.id, {
      attempts: [{ index: 0, durationMs: 0, upstreamResponse: { success: true, model: "test", usage: { input_tokens: 0, output_tokens: 0 }, body: null } }],
      _index: { derived: { responseSuccess: true, attemptCount: 1 } },
    })
    updateEntry(e2.id, {
      attempts: [
        {
          index: 0,
          durationMs: 0,
          error: "fail",
          upstreamResponse: {
            success: false,
            model: "test",
            usage: { input_tokens: 0, output_tokens: 0 },
            body: null,
          },
        },
      ],
      _index: { derived: { responseSuccess: false, failureReason: "fail", attemptCount: 1 } },
    })

    const successes = getHistorySummaries({ success: true })
    expect(successes.total).toBe(1)
    expect(successes.entries[0].id).toBe(e1.id)

    const failures = getHistorySummaries({ success: false })
    expect(failures.total).toBe(1)
    expect(failures.entries[0].id).toBe(e2.id)
  })

  test("filters by startedAt range (from)", async () => {
    const now = Date.now()
    const sessionId = getCurrentSession("anthropic-messages", generateId())!

    const old: HistoryEntry = {
      id: generateId(),
      sessionId,
      startedAt: now - 10000,
      endpoint: "anthropic-messages",
      model: { requested: "test" },
      clientRequest: { format: "anthropic-messages", model: "test", messages: [{ role: "user", content: "old" }] },
    }
    insertEntry(old)

    const recent: HistoryEntry = {
      id: generateId(),
      sessionId,
      startedAt: now,
      endpoint: "anthropic-messages",
      model: { requested: "test" },
      clientRequest: { format: "anthropic-messages", model: "test", messages: [{ role: "user", content: "new" }] },
    }
    insertEntry(recent)

    const result = getHistorySummaries({ from: now - 5000 })
    expect(result.total).toBe(1)
    expect(result.entries[0].id).toBe(recent.id)
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
      clientRequest: { format: "anthropic-messages", model: "test", messages: [{ role: "user", content: "old" }] },
    }
    insertEntry(old)

    const recent: HistoryEntry = {
      id: generateId(),
      sessionId,
      startedAt: now,
      endpoint: "anthropic-messages",
      model: { requested: "test" },
      clientRequest: { format: "anthropic-messages", model: "test", messages: [{ role: "user", content: "new" }] },
    }
    insertEntry(recent)

    const result = getHistorySummaries({ to: now - 5000 })
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
      clientRequest: { format: "anthropic-messages", model: "test", messages: [{ role: "user", content: "old" }] },
    }
    insertEntry(old)

    const mid: HistoryEntry = {
      id: generateId(),
      sessionId,
      startedAt: now - 10000,
      endpoint: "anthropic-messages",
      model: { requested: "test" },
      clientRequest: { format: "anthropic-messages", model: "test", messages: [{ role: "user", content: "mid" }] },
    }
    insertEntry(mid)

    const recent: HistoryEntry = {
      id: generateId(),
      sessionId,
      startedAt: now,
      endpoint: "anthropic-messages",
      model: { requested: "test" },
      clientRequest: { format: "anthropic-messages", model: "test", messages: [{ role: "user", content: "new" }] },
    }
    insertEntry(recent)

    const result = getHistorySummaries({ from: now - 15000, to: now - 5000 })
    expect(result.total).toBe(1)
    expect(result.entries[0].id).toBe(mid.id)
  })

  test("search matches message content", async () => {
    insertHistoryEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Tell me about quantum computing" }],
    })
    insertHistoryEntry("anthropic-messages", {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Write a poem about cats" }],
    })

    const result = getHistorySummaries({ search: "quantum" })
    expect(result.total).toBe(1)
    expect(result.entries[0].requestModel).toBe("claude-sonnet-4-20250514")
  })

  test("search is case-insensitive", async () => {
    insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "Hello World" }],
    })

    expect(getHistorySummaries({ search: "hello world" }).total).toBe(1)
    expect(getHistorySummaries({ search: "HELLO WORLD" }).total).toBe(1)
  })

  test("model is matched via the model filter, not free-text search", async () => {
    insertHistoryEntry("anthropic-messages", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hi" }],
    })

    expect(getHistorySummaries({ model: "sonnet" }).total).toBe(1)
    expect(getHistorySummaries({ search: "sonnet" }).total).toBe(0)
  })

  test("error messages are not free-text searchable (use the failed-status filter)", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
    })
    updateEntry(entry.id, {
      attempts: [
        {
          index: 0,
          durationMs: 0,
          error: "overloaded_error: server busy",
          upstreamResponse: {
            success: false,
            model: "test",
            usage: { input_tokens: 0, output_tokens: 0 },
            body: null,
          },
        },
      ],
      _index: { derived: { responseSuccess: false, failureReason: "overloaded_error: server busy", attemptCount: 1 } },
    })

    // RFC: the outbound response (incl. error) is not indexed for text search.
    expect(getHistorySummaries({ search: "overloaded" }).total).toBe(0)
    expect(getHistorySummaries({ success: false }).total).toBe(1)
  })

  test("filters by sessionId", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
    })

    expect(getHistorySummaries({ sessionId: entry.sessionId }).total).toBe(1)
    expect(getHistorySummaries({ sessionId: "nonexistent" }).total).toBe(0)
  })

  test("returns empty result when no entries match", async () => {
    insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "hello" }],
    })

    const result = getHistorySummaries({ search: "xyznonexistent" })
    expect(result.total).toBe(0)
    expect(result.entries).toHaveLength(0)
    expect(result.nextCursor).toBeNull()
  })
})

// ─── Summary cache consistency ───

describe("summary cache consistency", () => {
  test("clearHistory clears summaryIndex", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "hello" }],
    })
    expect(getSummary(entry.id)).toBeDefined()

    clearHistory()
    expect(getSummary(entry.id)).toBeUndefined()
    expect(getHistorySummaries().total).toBe(0)
  })

  test("initHistory clears summaryIndex", async () => {
    const entry = insertHistoryEntry("anthropic-messages", {
      model: "test",
      messages: [{ role: "user", content: "hello" }],
    })
    expect(getSummary(entry.id)).toBeDefined()

    await initHistory(true, 200)
    expect(getSummary(entry.id)).toBeUndefined()
  })

  test("multiple updateEntry calls rebuild summary correctly each time", async () => {
    const entry = createEmptyEntry("anthropic-messages")

    // Update 1: request data
    updateEntry(entry.id, {
      model: { requested: "claude-sonnet-4-20250514" },
      clientRequest: {
        format: "anthropic-messages",
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
    })
    expect(getSummary(entry.id)!.requestModel).toBe("claude-sonnet-4-20250514")

    // Update 2: pipelineInfo (summary should still have request data)
    updateEntry(entry.id, {
      pipelineInfo: {
        truncation: {
          wasTruncated: true,
          removedMessageCount: 1,
          originalTokens: 5000,
          compactedTokens: 3000,
          processingTimeMs: 5,
        },
      },
    })
    expect(getSummary(entry.id)!.requestModel).toBe("claude-sonnet-4-20250514")

    // Update 3: response
    updateEntry(entry.id, {
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "claude-sonnet-4-20250514",
            usage: { input_tokens: 100, output_tokens: 50 },
            body: { role: "assistant", content: "Hi" },
          },
        },
      ],
      _index: { derived: { responseSuccess: true, attemptCount: 1 } },
      durationMs: 200,
    })
    const final = getSummary(entry.id)!
    expect(final.requestModel).toBe("claude-sonnet-4-20250514")
    expect(final.responseSuccess).toBe(true)
    expect(final.durationMs).toBe(200)
  })

  test("getHistorySummaries and getSummary return consistent data", async () => {
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
            body: null,
          },
        },
      ],
      _index: { derived: { responseSuccess: true, attemptCount: 1 } },
      durationMs: 200,
    })

    const fromList = getHistorySummaries().entries.find((s: EntrySummary) => s.id === entry.id)!
    const fromDirect = getSummary(entry.id)!

    // Both should return the same summary object
    expect(fromList.id).toBe(fromDirect.id)
    expect(fromList.requestModel).toBe(fromDirect.requestModel)
    expect(fromList.responseSuccess).toBe(fromDirect.responseSuccess)
    expect(fromList.durationMs).toBe(fromDirect.durationMs)
    expect(fromList.previewText).toBe(fromDirect.previewText)
  })
})
