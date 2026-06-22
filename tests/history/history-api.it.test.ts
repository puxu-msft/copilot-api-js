/**
 * Tests for history API route handlers.
 *
 * Tests the Hono route handlers in routes/history/handler.ts by mounting them
 * on a test Hono app and exercising via app.request(). Verifies query param
 * parsing, response formats, error handling, and data flow.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { Hono } from "hono"

import {
  //
  clearHistory,
  getCurrentSession,
  finalizeEntry,
  getEntry,
  initHistory,
  insertEntry,
  shutdownHistory,
  updateEntry,
  type EndpointType,
  type HistoryEntry,
} from "~/lib/history"
import { persistEntryEager } from "~/lib/history/store"
import { setStateForTests } from "~/lib/state"
import { generateId } from "~/lib/utils"
import {
  //
  handleDeleteEntries,
  handleDeleteSession,
  handleExport,
  handleGetEntries,
  handleGetEntry,
  handleGetSession,
  handleGetSessions,
  handleGetStats,
  handlePinEntry,
  handleUnpinEntry,
} from "~/routes/history/handler"

// ─── Test app ───

const app = new Hono()
app.get("/api/entries", handleGetEntries)
app.get("/api/entries/:id", handleGetEntry)
app.post("/api/entries/:id/pin", handlePinEntry)
app.post("/api/entries/:id/unpin", handleUnpinEntry)
app.delete("/api/entries", handleDeleteEntries)
app.get("/api/stats", handleGetStats)
app.get("/api/export", handleExport)
app.get("/api/sessions", handleGetSessions)
app.get("/api/sessions/:id", handleGetSession)
app.delete("/api/sessions/:id", handleDeleteSession)

// ─── Helpers ───

function createEntry(endpoint: EndpointType, model: string, messages: HistoryEntry["inboundRequest"]["messages"], extra?: Partial<HistoryEntry>): HistoryEntry {
  const sessionId = getCurrentSession(endpoint, generateId())
  const entry: HistoryEntry = {
    id: generateId(),
    sessionId,
    startedAt: Date.now(),
    endpoint,
    inboundRequest: { model, messages, stream: true },
    ...extra,
  }
  insertEntry(entry)
  updateEntry(entry.id, {
    state: "completed",
    outboundResponse: {
      success: true,
      model,
      usage: { input_tokens: 0, output_tokens: 0 },
      content: null,
    },
  })
  finalizeEntry(entry.id)
  return entry
}

async function get(path: string) {
  return app.request(path)
}

async function del(path: string) {
  return app.request(path, { method: "DELETE" })
}

async function post(path: string) {
  return app.request(path, { method: "POST" })
}

async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T
}

// ─── Setup / Teardown ───

beforeEach(() => {
  setStateForTests({ historyDbPath: ":memory:" })
  initHistory(true, 200)
})

afterEach(() => {
  clearHistory()
  shutdownHistory()
  setStateForTests({ historyDbPath: "" })
})

// ─── handleGetEntries ───

describe("GET /api/entries", () => {
  test("returns empty result when no entries", async () => {
    const res = await get("/api/entries")
    expect(res.status).toBe(200)
    const body = await json<{ entries: Array<unknown>; total: number }>(res)
    expect(body.total).toBe(0)
    expect(body.entries).toHaveLength(0)
  })

  test("returns summaries sorted by startedAt descending", async () => {
    createEntry("anthropic-messages", "model-a", [{ role: "user", content: "first" }])
    createEntry("anthropic-messages", "model-b", [{ role: "user", content: "second" }])

    const res = await get("/api/entries")
    const body = await json<{ entries: Array<{ requestModel: string; startedAt: number }> }>(res)
    expect(body.entries).toHaveLength(2)
    expect(body.entries[0].startedAt).toBeGreaterThanOrEqual(body.entries[1].startedAt)
  })

  test("paginates with cursor and limit params", async () => {
    for (let i = 0; i < 5; i++) {
      createEntry("anthropic-messages", "test", [{ role: "user", content: `msg-${i}` }])
    }

    const res1 = await get("/api/entries?limit=2")
    const body1 = await json<{
      entries: Array<{ id: string }>
      total: number
      nextCursor: string | null
      prevCursor: string | null
    }>(res1)
    expect(body1.entries).toHaveLength(2)
    expect(body1.total).toBe(5)
    expect(body1.nextCursor).not.toBeNull()
    expect(body1.prevCursor).toBeNull()

    // Load next page using cursor
    const res2 = await get(`/api/entries?cursor=${body1.nextCursor}&limit=2`)
    const body2 = await json<{
      entries: Array<{ id: string }>
      total: number
      nextCursor: string | null
      prevCursor: string | null
    }>(res2)
    expect(body2.entries).toHaveLength(2)
    expect(body2.prevCursor).not.toBeNull()
  })

  // Filter logic is thoroughly tested in history-summary.test.ts.
  // API tests focus on query param parsing and passthrough.

  test("passes filter params to getHistorySummaries correctly", async () => {
    createEntry("anthropic-messages", "claude-sonnet-4-20250514", [{ role: "user", content: "quantum" }])
    createEntry("openai-chat-completions", "gpt-4o", [{ role: "user", content: "poetry" }])

    // Verify a representative filter to confirm param passthrough
    const res = await get("/api/entries?model=claude&endpoint=anthropic-messages")
    const body = await json<{ total: number }>(res)
    expect(body.total).toBe(1)
  })

  test("ignores empty string params", async () => {
    createEntry("anthropic-messages", "test", [{ role: "user", content: "hello" }])

    const res = await get("/api/entries?model=&search=&sessionId=")
    const body = await json<{ total: number }>(res)
    // Empty strings should not filter — all entries returned
    expect(body.total).toBe(1)
  })
})

// ─── handleGetEntry ───

describe("GET /api/entries/:id", () => {
  test("returns full entry by id", async () => {
    const entry = createEntry("anthropic-messages", "claude-sonnet-4-20250514", [{ role: "user", content: "hello" }], {
      effectiveRequest: {
        model: "claude-sonnet-4-20250514",
        format: "anthropic-messages",
        messageCount: 1,
        messages: [{ role: "user", content: "hello" }],
        payload: {
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 4096,
        },
      },
      outboundRequest: {
        model: "claude-sonnet-4-20250514",
        format: "anthropic-messages",
        messageCount: 1,
        messages: [{ role: "user", content: "hello" }],
        payload: {
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 4096,
          stream: true,
        },
      },
      httpHeaders: {
        outboundRequest: {
          "anthropic-beta": "advanced-tool-use-2025-11-20",
        },
      },
    })

    const res = await get(`/api/entries/${entry.id}`)
    expect(res.status).toBe(200)
    const body = await json<HistoryEntry>(res)
    expect(body.id).toBe(entry.id)
    expect(body.inboundRequest.model).toBe("claude-sonnet-4-20250514")
    expect(body.inboundRequest.messages).toHaveLength(1)
    expect(body.effectiveRequest?.payload).toEqual({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 4096,
    })
    expect(body.outboundRequest).toEqual({
      model: "claude-sonnet-4-20250514",
      format: "anthropic-messages",
      messageCount: 1,
      messages: [{ role: "user", content: "hello" }],
      payload: {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 4096,
        stream: true,
      },
    })
    expect(body.httpHeaders).toEqual({
      outboundRequest: {
        "anthropic-beta": "advanced-tool-use-2025-11-20",
      },
    })
  })

  test("returns 404 for non-existent id", async () => {
    const res = await get("/api/entries/nonexistent-id")
    expect(res.status).toBe(404)
    const body = await json<{ error: string }>(res)
    expect(body.error).toContain("not found")
  })
})

// ─── handlePinEntry / handleUnpinEntry ───

describe("POST /api/entries/:id/pin and /unpin", () => {
  test("pin returns the updated entry with pinned=true and persists it", async () => {
    const entry = createEntry("anthropic-messages", "test", [{ role: "user", content: "keep me" }])

    const res = await post(`/api/entries/${entry.id}/pin`)
    expect(res.status).toBe(200)
    const body = await json<HistoryEntry>(res)
    expect(body.id).toBe(entry.id)
    expect(body.pinned).toBe(true)

    // A subsequent GET reflects the persisted pin state.
    const getRes = await get(`/api/entries/${entry.id}`)
    expect((await json<HistoryEntry>(getRes)).pinned).toBe(true)
  })

  test("unpin clears the flag", async () => {
    const entry = createEntry("anthropic-messages", "test", [{ role: "user", content: "toggle" }])
    await post(`/api/entries/${entry.id}/pin`)

    const res = await post(`/api/entries/${entry.id}/unpin`)
    expect(res.status).toBe(200)
    expect((await json<HistoryEntry>(res)).pinned).toBe(false)

    const getRes = await get(`/api/entries/${entry.id}`)
    expect((await json<HistoryEntry>(getRes)).pinned).toBe(false)
  })

  test("pin returns 404 for a non-existent id", async () => {
    const res = await post("/api/entries/nope/pin")
    expect(res.status).toBe(404)
    expect((await json<{ error: string }>(res)).error).toContain("not found")
  })

  test("pinning an eager-persisted in-flight entry reflects pinned in the response (in-flight view synced)", async () => {
    // An entry that is eager-persisted (sqlite head row) but still in-flight
    // (not finalized). getEntry reads in-flight FIRST, so setPinned must sync the
    // in-flight copy — otherwise the column says pinned=1 but the response says false.
    const entry: HistoryEntry = {
      id: generateId(),
      startedAt: Date.now(),
      endpoint: "anthropic-messages",
      state: "streaming",
      active: true,
      inboundRequest: { model: "test", messages: [{ role: "user", content: "live" }], stream: true },
    }
    insertEntry(entry)
    persistEntryEager(entry) // writes the sqlite head row (status=streaming) while still in-flight

    const res = await post(`/api/entries/${entry.id}/pin`)
    expect(res.status).toBe(200)
    expect((await json<HistoryEntry>(res)).pinned).toBe(true)
    // The in-flight read also reflects it now.
    expect(getEntry(entry.id)?.pinned).toBe(true)
  })
})

// ─── handleDeleteEntries ───

describe("DELETE /api/entries", () => {
  test("clears all history", async () => {
    createEntry("anthropic-messages", "test", [{ role: "user", content: "hello" }])
    createEntry("anthropic-messages", "test", [{ role: "user", content: "world" }])

    const res = await del("/api/entries")
    expect(res.status).toBe(200)
    const body = await json<{ success: boolean }>(res)
    expect(body.success).toBe(true)

    // Verify empty
    const listRes = await get("/api/entries")
    const listBody = await json<{ total: number }>(listRes)
    expect(listBody.total).toBe(0)
  })
})

// ─── handleGetStats ───

describe("GET /api/stats", () => {
  test("returns stats object", async () => {
    createEntry("anthropic-messages", "test", [{ role: "user", content: "hello" }])

    const res = await get("/api/stats")
    expect(res.status).toBe(200)
    const body = await json<Record<string, unknown>>(res)
    expect(body).toBeDefined()
    expect(typeof body).toBe("object")
  })
})

// ─── handleExport ───

describe("GET /api/export", () => {
  test("exports as JSON by default", async () => {
    createEntry("anthropic-messages", "test", [{ role: "user", content: "hello" }])

    const res = await get("/api/export")
    expect(res.headers.get("Content-Type")).toContain("application/json")
    expect(res.headers.get("Content-Disposition")).toContain("history.json")
  })

  test("exports as CSV when format=csv", async () => {
    createEntry("anthropic-messages", "test", [{ role: "user", content: "hello" }])

    const res = await get("/api/export?format=csv")
    expect(res.headers.get("Content-Type")).toContain("text/csv")
    expect(res.headers.get("Content-Disposition")).toContain("history.csv")
  })
})

// ─── handleGetSessions / handleGetSession / handleDeleteSession ───

describe("sessions API", () => {
  test("GET /api/sessions returns sessions list", async () => {
    createEntry("anthropic-messages", "test", [{ role: "user", content: "hello" }])

    const res = await get("/api/sessions")
    expect(res.status).toBe(200)
    const body = await json<{ sessions: Array<unknown> }>(res)
    expect(body.sessions.length).toBeGreaterThanOrEqual(1)
  })

  test("GET /api/sessions/:id returns session with entries", async () => {
    const entry = createEntry("anthropic-messages", "test", [{ role: "user", content: "hello" }])
    expect(entry.sessionId).toBeTruthy()

    const res = await get(`/api/sessions/${entry.sessionId}`)
    expect(res.status).toBe(200)
    const body = await json<{ id: string; entries: Array<unknown> }>(res)
    expect(body.id).toBe(entry.sessionId!)
    expect(body.entries.length).toBeGreaterThanOrEqual(1)
  })

  test("GET /api/sessions/:id returns 404 for non-existent session", async () => {
    const res = await get("/api/sessions/nonexistent")
    expect(res.status).toBe(404)
  })

  test("DELETE /api/sessions/:id deletes session", async () => {
    const entry = createEntry("anthropic-messages", "test", [{ role: "user", content: "hello" }])
    const sessionId = entry.sessionId

    const res = await del(`/api/sessions/${sessionId}`)
    expect(res.status).toBe(200)
    const body = await json<{ success: boolean }>(res)
    expect(body.success).toBe(true)

    // Verify deleted
    expect(getEntry(entry.id)).toBeUndefined()
  })

  test("DELETE /api/sessions/:id returns 404 for non-existent session", async () => {
    const res = await del("/api/sessions/nonexistent")
    expect(res.status).toBe(404)
  })
})
