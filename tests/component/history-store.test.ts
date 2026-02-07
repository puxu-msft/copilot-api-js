/**
 * Characterization tests for history recording
 *
 * Captures current behavior before refactoring:
 * - initHistory enables/disables recording
 * - recordRequest creates entries and returns IDs
 * - recordResponse updates entries with response data
 * - recordTruncation adds truncation metadata
 * - recordRewrites adds rewrite metadata + backward compat truncation
 * - getHistory filters, paginates, and sorts entries
 * - clearHistory resets state
 * - getStats computes aggregate statistics
 * - Session management and max entries enforcement
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  clearHistory,
  getEntry,
  getHistory,
  getStats,
  historyState,
  initHistory,
  isHistoryEnabled,
  recordRequest,
  recordResponse,
  recordRewrites,
  recordTruncation,
} from "~/lib/history"

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
    recordRequest("anthropic", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "test" }],
      stream: true,
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

// ─── recordRequest ───

describe("recordRequest", () => {
  test("returns non-empty ID when enabled", () => {
    const id = recordRequest("anthropic", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    })

    expect(id).toBeTruthy()
    expect(typeof id).toBe("string")
  })

  test("returns empty string when disabled", () => {
    initHistory(false, 100)
    const id = recordRequest("anthropic", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    })

    expect(id).toBe("")
  })

  test("creates entry with correct fields", () => {
    const id = recordRequest("anthropic", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      system: "You are helpful",
      max_tokens: 1024,
      temperature: 0.5,
      tools: [{ name: "search", description: "Search tool" }],
    })

    const entry = getEntry(id)
    expect(entry).toBeDefined()
    expect(entry!.endpoint).toBe("anthropic")
    expect(entry!.request.model).toBe("claude-sonnet-4-20250514")
    expect(entry!.request.messages).toHaveLength(1)
    expect(entry!.request.stream).toBe(true)
    expect(entry!.request.system).toBe("You are helpful")
    expect(entry!.request.max_tokens).toBe(1024)
    expect(entry!.request.temperature).toBe(0.5)
    expect(entry!.request.tools).toHaveLength(1)
    expect(entry!.response).toBeUndefined()
  })

  test("assigns sessionId to entry", () => {
    const id = recordRequest("anthropic", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "test" }],
      stream: true,
    })

    const entry = getEntry(id)
    expect(entry!.sessionId).toBeTruthy()
  })

  test("tracks tools used in session", () => {
    recordRequest("anthropic", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "test" }],
      stream: true,
      tools: [{ name: "file_search" }, { name: "read_file" }],
    })

    const session = historyState.sessions.get(historyState.currentSessionId)
    expect(session).toBeDefined()
    expect(session!.toolsUsed).toContain("file_search")
    expect(session!.toolsUsed).toContain("read_file")
  })

  test("increments session request count", () => {
    recordRequest("anthropic", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "1" }],
      stream: true,
    })
    recordRequest("anthropic", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "2" }],
      stream: true,
    })

    const session = historyState.sessions.get(historyState.currentSessionId)
    expect(session!.requestCount).toBe(2)
  })
})

// ─── recordResponse ───

describe("recordResponse", () => {
  test("updates entry with response data", () => {
    const id = recordRequest("anthropic", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    })

    recordResponse(
      id,
      {
        success: true,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 100, output_tokens: 50 },
        stop_reason: "end_turn",
        content: { role: "assistant", content: "Hi there" },
      },
      500,
    )

    const entry = getEntry(id)
    expect(entry!.response).toBeDefined()
    expect(entry!.response!.success).toBe(true)
    expect(entry!.response!.model).toBe("claude-sonnet-4-20250514")
    expect(entry!.response!.usage.input_tokens).toBe(100)
    expect(entry!.response!.usage.output_tokens).toBe(50)
    expect(entry!.response!.stop_reason).toBe("end_turn")
    expect(entry!.durationMs).toBe(500)
  })

  test("records error response", () => {
    const id = recordRequest("anthropic", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    })

    recordResponse(
      id,
      {
        success: false,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 0, output_tokens: 0 },
        error: "Rate limited",
        content: null,
      },
      100,
    )

    const entry = getEntry(id)
    expect(entry!.response!.success).toBe(false)
    expect(entry!.response!.error).toBe("Rate limited")
  })

  test("does nothing when disabled", () => {
    initHistory(false, 100)
    recordResponse(
      "nonexistent",
      {
        success: true,
        model: "test",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: null,
      },
      0,
    )
    // Should not throw
  })

  test("updates session token stats", () => {
    const id = recordRequest("anthropic", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    })

    recordResponse(
      id,
      {
        success: true,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 100, output_tokens: 50 },
        content: null,
      },
      500,
    )

    const session = historyState.sessions.get(historyState.currentSessionId)
    expect(session!.totalInputTokens).toBe(100)
    expect(session!.totalOutputTokens).toBe(50)
  })
})

// ─── recordTruncation ───

describe("recordTruncation", () => {
  test("adds truncation info to entry", () => {
    const id = recordRequest("anthropic", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    })

    const truncation = {
      removedMessageCount: 5,
      originalTokens: 10000,
      compactedTokens: 5000,
      processingTimeMs: 50,
    }

    recordTruncation(id, truncation)

    const entry = getEntry(id)
    expect(entry!.truncation).toBeDefined()
    expect(entry!.truncation!.removedMessageCount).toBe(5)
    expect(entry!.truncation!.originalTokens).toBe(10000)
    expect(entry!.truncation!.compactedTokens).toBe(5000)
  })
})

// ─── recordRewrites ───

describe("recordRewrites", () => {
  test("adds rewrite info to entry", () => {
    const id = recordRequest("anthropic", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    })

    recordRewrites(id, {
      sanitization: {
        removedBlockCount: 2,
        systemReminderRemovals: 1,
      },
      rewrittenMessages: [{ role: "user", content: "hello" }],
      messageMapping: [0],
    })

    const entry = getEntry(id)
    expect(entry!.rewrites).toBeDefined()
    expect(entry!.rewrites!.sanitization!.removedBlockCount).toBe(2)
    expect(entry!.rewrites!.rewrittenMessages).toHaveLength(1)
    expect(entry!.rewrites!.messageMapping).toEqual([0])
  })

  test("also sets truncation for backward compatibility", () => {
    const id = recordRequest("anthropic", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    })

    const truncation = {
      removedMessageCount: 3,
      originalTokens: 8000,
      compactedTokens: 4000,
      processingTimeMs: 30,
    }

    recordRewrites(id, {
      truncation,
    })

    const entry = getEntry(id)
    expect(entry!.rewrites!.truncation).toBeDefined()
    expect(entry!.truncation).toBeDefined() // Backward compat
    expect(entry!.truncation!.removedMessageCount).toBe(3)
  })
})

// ─── getHistory ───

describe("getHistory", () => {
  test("returns entries sorted by timestamp descending", () => {
    recordRequest("anthropic", {
      model: "model-a",
      messages: [{ role: "user", content: "first" }],
      stream: true,
    })
    recordRequest("anthropic", {
      model: "model-b",
      messages: [{ role: "user", content: "second" }],
      stream: true,
    })

    const result = getHistory()
    expect(result.entries.length).toBe(2)
    expect(result.entries[0].timestamp).toBeGreaterThanOrEqual(result.entries[1].timestamp)
  })

  test("paginates results", () => {
    for (let i = 0; i < 5; i++) {
      recordRequest("anthropic", {
        model: "model",
        messages: [{ role: "user", content: `msg-${i}` }],
        stream: true,
      })
    }

    const page1 = getHistory({ page: 1, limit: 2 })
    expect(page1.entries.length).toBe(2)
    expect(page1.total).toBe(5)
    expect(page1.totalPages).toBe(3)
    expect(page1.page).toBe(1)

    const page2 = getHistory({ page: 2, limit: 2 })
    expect(page2.entries.length).toBe(2)
  })

  test("filters by model name", () => {
    recordRequest("anthropic", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "a" }],
      stream: true,
    })
    recordRequest("anthropic", {
      model: "gpt-4o",
      messages: [{ role: "user", content: "b" }],
      stream: true,
    })

    const result = getHistory({ model: "claude" })
    expect(result.total).toBe(1)
    expect(result.entries[0].request.model).toContain("claude")
  })

  test("filters by endpoint", () => {
    recordRequest("anthropic", {
      model: "test",
      messages: [{ role: "user", content: "a" }],
      stream: true,
    })
    recordRequest("openai", {
      model: "test",
      messages: [{ role: "user", content: "b" }],
      stream: true,
    })

    const result = getHistory({ endpoint: "openai" })
    expect(result.total).toBe(1)
    expect(result.entries[0].endpoint).toBe("openai")
  })
})

// ─── clearHistory ───

describe("clearHistory", () => {
  test("removes all entries and sessions", () => {
    recordRequest("anthropic", {
      model: "test",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
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
    const id = recordRequest("anthropic", {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    })

    recordResponse(
      id,
      {
        success: true,
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 100, output_tokens: 50 },
        content: null,
      },
      500,
    )

    const stats = getStats()
    expect(stats.totalRequests).toBe(1)
    expect(stats.successfulRequests).toBe(1)
    expect(stats.failedRequests).toBe(0)
    expect(stats.totalInputTokens).toBe(100)
    expect(stats.totalOutputTokens).toBe(50)
    expect(stats.averageDurationMs).toBe(500)
    expect(stats.modelDistribution["claude-sonnet-4-20250514"]).toBe(1)
    expect(stats.endpointDistribution["anthropic"]).toBe(1)
  })
})

// ─── Max entries enforcement ───

describe("Max entries enforcement", () => {
  test("removes oldest entries when exceeding maxEntries", () => {
    initHistory(true, 3)

    const ids: Array<string> = []
    for (let i = 0; i < 5; i++) {
      ids.push(
        recordRequest("anthropic", {
          model: "test",
          messages: [{ role: "user", content: `msg-${i}` }],
          stream: true,
        }),
      )
    }

    expect(historyState.entries.length).toBe(3)
    // Oldest entries should be removed (FIFO)
    expect(getEntry(ids[0])).toBeUndefined()
    expect(getEntry(ids[1])).toBeUndefined()
    expect(getEntry(ids[2])).toBeDefined()
  })
})
