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
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

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
import { closeArchiveDb } from "~/lib/history/sqlite/archive-db"
import { getDatabase } from "~/lib/history/sqlite/connection"
import { querySummaries } from "~/lib/history/sqlite/read"
import { setStateForTests } from "~/lib/state"
import { generateId } from "~/lib/utils"
import {
  //
  handleArchiveCooldown,
  handleArchiveNow,
  handleExport,
  handleGetEntries,
  handleGetEntry,
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
app.post("/api/archive-now", handleArchiveNow)
app.post("/api/archive-cooldown", handleArchiveCooldown)
app.get("/api/stats", handleGetStats)
app.get("/api/export", handleExport)

// ─── Helpers ───

async function createEntry(
  endpoint: EndpointType,
  model: string,
  messages: NonNullable<HistoryEntry["clientRequest"]>["messages"],
  extra?: Partial<HistoryEntry>,
): Promise<HistoryEntry> {
  const sessionId = getCurrentSession(endpoint, generateId())
  const entry: HistoryEntry = {
    id: generateId(),
    sessionId,
    startedAt: Date.now(),
    endpoint,
    model: { requested: model },
    clientRequest: { format: endpoint, model, messages, stream: true },
    ...extra,
  }
  insertEntry(entry)
  // Complete with the caller-supplied attempts (carrying the effectiveSource /
  // upstreamRequest legs under test) or a default single successful attempt.
  const attempts = entry.attempts ?? [
    {
      index: 0,
      durationMs: 0,
      upstreamResponse: { success: true, model, usage: { input_tokens: 0, output_tokens: 0 }, body: null },
    },
  ]
  updateEntry(entry.id, {
    state: "completed",
    attempts,
    _index: { derived: { responseSuccess: true, attemptCount: attempts.length } },
  })
  await finalizeEntry(entry.id)
  return entry
}

async function get(path: string) {
  return app.request(path)
}

async function post(path: string) {
  return app.request(path, { method: "POST" })
}

async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T
}

// ─── Setup / Teardown ───

let archiveDir: string

beforeEach(async () => {
  archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-api-archive-"))
  setStateForTests({ historyDbPath: ":memory:", historyArchiveEnabled: true, historyArchiveDir: archiveDir })
  initHistory(true, 200)
})

afterEach(async () => {
  clearHistory()
  await shutdownHistory()
  closeArchiveDb()
  setStateForTests({ historyDbPath: "", historyArchiveDir: "" })
  fs.rmSync(archiveDir, { recursive: true, force: true })
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
    await createEntry("anthropic-messages", "model-a", [{ role: "user", content: "first" }])
    await createEntry("anthropic-messages", "model-b", [{ role: "user", content: "second" }])

    const res = await get("/api/entries")
    const body = await json<{ entries: Array<{ requestModel: string; startedAt: number }> }>(res)
    expect(body.entries).toHaveLength(2)
    expect(body.entries[0].startedAt).toBeGreaterThanOrEqual(body.entries[1].startedAt)
  })

  test("paginates with cursor and limit params", async () => {
    for (let i = 0; i < 5; i++) {
      await createEntry("anthropic-messages", "test", [{ role: "user", content: `msg-${i}` }])
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
    await createEntry("anthropic-messages", "claude-sonnet-4-20250514", [{ role: "user", content: "quantum" }])
    await createEntry("openai-chat-completions", "gpt-4o", [{ role: "user", content: "poetry" }])

    // Verify a representative filter to confirm param passthrough
    const res = await get("/api/entries?model=claude&endpoint=anthropic-messages")
    const body = await json<{ total: number }>(res)
    expect(body.total).toBe(1)
  })

  test("ignores empty string params", async () => {
    await createEntry("anthropic-messages", "test", [{ role: "user", content: "hello" }])

    const res = await get("/api/entries?model=&search=&sessionId=")
    const body = await json<{ total: number }>(res)
    // Empty strings should not filter — all entries returned
    expect(body.total).toBe(1)
  })

  test("terminalOnly=true excludes active in-flight (streaming) entries", async () => {
    const done = await createEntry("anthropic-messages", "test", [{ role: "user", content: "done" }])
    // Active in-flight streaming entry (what the Live lane shows) — not finalized.
    const live: HistoryEntry = {
      id: generateId(),
      startedAt: Date.now() + 1,
      endpoint: "anthropic-messages",
      state: "streaming",
      active: true,
      model: { requested: "test" },
      clientRequest: { format: "anthropic-messages", model: "test", messages: [{ role: "user", content: "live" }], stream: true },
    }
    insertEntry(live)

    // Default merges in-flight (richest data): both ids present.
    const all = await json<{ entries: Array<{ id: string }>; total: number }>(await get("/api/entries"))
    expect(all.total).toBe(2)
    expect(all.entries.map((e) => e.id).sort()).toEqual([done.id, live.id].sort())

    // terminalOnly drops the in-flight row.
    const terminal = await json<{ entries: Array<{ id: string }>; total: number }>(await get("/api/entries?terminalOnly=true"))
    expect(terminal.total).toBe(1)
    expect(terminal.entries.map((e) => e.id)).toEqual([done.id])
  })
})

// ─── handleGetEntry ───

describe("GET /api/entries/:id", () => {
  test("returns full entry by id", async () => {
    const entry = await createEntry("anthropic-messages", "claude-sonnet-4-20250514", [{ role: "user", content: "hello" }], {
      attempts: [
        {
          index: 0,
          durationMs: 0,
          effectiveSource: {
            model: "claude-sonnet-4-20250514",
            format: "anthropic-messages",
            messageCount: 1,
            messages: [{ role: "user", content: "hello" }],
            body: {
              model: "claude-sonnet-4-20250514",
              messages: [{ role: "user", content: "hello" }],
              max_tokens: 4096,
            },
          },
          upstreamRequest: {
            model: "claude-sonnet-4-20250514",
            format: "anthropic-messages",
            messages: [{ role: "user", content: "hello" }],
            headers: {
              "anthropic-beta": "advanced-tool-use-2025-11-20",
            },
            body: {
              model: "claude-sonnet-4-20250514",
              messages: [{ role: "user", content: "hello" }],
              max_tokens: 4096,
              stream: true,
            },
          },
          upstreamResponse: {
            success: true,
            model: "claude-sonnet-4-20250514",
            usage: { input_tokens: 0, output_tokens: 0 },
            body: null,
          },
        },
      ],
    })

    const res = await get(`/api/entries/${entry.id}`)
    expect(res.status).toBe(200)
    const body = await json<HistoryEntry>(res)
    expect(body.id).toBe(entry.id)
    expect(body.clientRequest?.model).toBe("claude-sonnet-4-20250514")
    expect(body.clientRequest?.messages).toHaveLength(1)
    const attempt = body.attempts?.at(-1)
    expect(attempt?.effectiveSource?.body).toEqual({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 4096,
    })
    expect(attempt?.upstreamRequest).toEqual({
      model: "claude-sonnet-4-20250514",
      format: "anthropic-messages",
      messages: [{ role: "user", content: "hello" }],
      headers: {
        "anthropic-beta": "advanced-tool-use-2025-11-20",
      },
      body: {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 4096,
        stream: true,
      },
    })
    expect(attempt?.upstreamRequest?.headers).toEqual({
      "anthropic-beta": "advanced-tool-use-2025-11-20",
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
    const entry = await createEntry("anthropic-messages", "test", [{ role: "user", content: "keep me" }])

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
    const entry = await createEntry("anthropic-messages", "test", [{ role: "user", content: "toggle" }])
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
      model: { requested: "test" },
      clientRequest: { format: "anthropic-messages", model: "test", messages: [{ role: "user", content: "live" }], stream: true },
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

// ─── handleArchiveNow (product-facing replacement for delete) ───

describe("POST /api/archive-now", () => {
  test("with no filter archives ALL terminal entries (moved to tier-1, not deleted)", async () => {
    await createEntry("anthropic-messages", "test", [{ role: "user", content: "hello" }])
    await createEntry("anthropic-messages", "test", [{ role: "user", content: "world" }])

    const res = await post("/api/archive-now")
    expect(res.status).toBe(200)
    expect(await json<{ success: boolean; archived: number }>(res)).toEqual({ success: true, archived: 2 })

    // HOT view now empty…
    const listBody = await json<{ total: number }>(await get("/api/entries"))
    expect(listBody.total).toBe(0)
    // …but the rows moved to the archive view (never truly deleted).
    expect(querySummaries({ tier: "archive", limit: 100 })).toHaveLength(2)
  })

  test("with an endpoint filter archives only matching rows and returns the count", async () => {
    await createEntry("anthropic-messages", "test", [{ role: "user", content: "anthropic" }])
    const openai = await createEntry("openai-chat-completions", "gpt-4o", [{ role: "user", content: "openai" }])

    const res = await post("/api/archive-now?endpoint=anthropic-messages")
    expect(res.status).toBe(200)
    expect(await json<{ success: boolean; archived: number }>(res)).toEqual({ success: true, archived: 1 })

    // Only the non-matching entry survives in HOT.
    const list = await json<{ entries: Array<{ id: string }> }>(await get("/api/entries?terminalOnly=true"))
    expect(list.entries.map((e) => e.id)).toEqual([openai.id])
  })
})

// ─── handleArchiveCooldown (age-based on-demand cool-down) ───

describe("POST /api/archive-cooldown", () => {
  test("moves only rows older than hot_days into tier-1; recent rows stay HOT", async () => {
    setStateForTests({ historyArchiveHotDays: 3 })
    const old = await createEntry("anthropic-messages", "test", [{ role: "user", content: "old" }])
    const recent = await createEntry("anthropic-messages", "test", [{ role: "user", content: "recent" }])
    // backdate `old` past the hot window (createEntry stamps started_at ≈ now).
    getDatabase()
      .prepare("UPDATE entries_v2 SET started_at = ? WHERE id = ?")
      .run(Date.now() - 5 * 86400_000, old.id)

    const res = await post("/api/archive-cooldown")
    expect(res.status).toBe(200)
    expect(await json<{ success: boolean; migrated: number }>(res)).toEqual({ success: true, migrated: 1 })

    // old → archive view (cooled), recent stays in HOT view.
    expect(querySummaries({ tier: "archive", limit: 100 }).map((s) => s.id)).toEqual([old.id])
    const hot = await json<{ entries: Array<{ id: string }> }>(await get("/api/entries?terminalOnly=true"))
    expect(hot.entries.map((e) => e.id)).toEqual([recent.id])
  })
})

// ─── handleGetStats ───

describe("GET /api/stats", () => {
  test("returns stats object", async () => {
    await createEntry("anthropic-messages", "test", [{ role: "user", content: "hello" }])

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
    await createEntry("anthropic-messages", "test", [{ role: "user", content: "hello" }])

    const res = await get("/api/export")
    expect(res.headers.get("Content-Type")).toContain("application/json")
    expect(res.headers.get("Content-Disposition")).toContain("history.json")
  })

  test("exports as CSV when format=csv", async () => {
    await createEntry("anthropic-messages", "test", [{ role: "user", content: "hello" }])

    const res = await get("/api/export?format=csv")
    expect(res.headers.get("Content-Type")).toContain("text/csv")
    expect(res.headers.get("Content-Disposition")).toContain("history.csv")
  })
})

// ─── sessions API ───
// (DELETE /api/sessions/:id removed with the product-facing delete surface, spec
// §3.6; archiving a session is done via POST /api/archive-now?sessionId=….)
