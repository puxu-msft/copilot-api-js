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
  beforeAll,
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
  initHistory,
  insertEntry,
  shutdownHistory,
  type EndpointType,
  type HistoryEntry,
} from "~/lib/history"
import { setStateForTests } from "~/lib/state"
import { generateId } from "~/lib/utils"
import {
  //
  handleExport,
  handleGetEntries,
  handleGetEntry,
  handleGetStats,
  handlePinEntry,
  handleSearch,
  handleSearchContains,
  handleUnpinEntry,
} from "~/routes/history/handler"

import { commitV3HistoryEntry } from "../helpers/history-v3-fixtures"
import { primeUdsConnectForBunTest } from "../helpers/prime-uds-for-bun-test"

// See prime-uds-for-bun-test.ts's doc comment: `handleSearch` (Phase 4 cutover)
// now calls the sidecar's UDS client, whose FIRST-EVER connect attempt in this
// file (against a socket path with no sidecar listening, the common case here)
// is exactly the `bun test`-only scenario that needs priming.
beforeAll(primeUdsConnectForBunTest)

// ─── Test app ───

const app = new Hono()
app.get("/api/entries", handleGetEntries)
app.get("/api/entries/:id", handleGetEntry)
app.post("/api/entries/:id/pin", handlePinEntry)
app.post("/api/entries/:id/unpin", handleUnpinEntry)
app.get("/api/stats", handleGetStats)
app.get("/api/export", handleExport)
app.get("/api/search", handleSearch)
app.get("/api/search/contains", handleSearchContains)

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
  // Complete with the caller-supplied attempts (carrying the effectiveSource /
  // upstreamRequest legs under test) or a default single successful attempt.
  const attempts = entry.attempts ?? [
    {
      index: 0,
      durationMs: 0,
      upstreamResponse: { success: true, model, usage: { input_tokens: 0, output_tokens: 0 }, body: null },
    },
  ]
  const completed: HistoryEntry = {
    ...entry,
    state: "completed",
    attempts,
    _index: { derived: { responseSuccess: true, attemptCount: attempts.length } },
  }
  commitV3HistoryEntry(completed)
  return completed
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

beforeEach(async () => {
  setStateForTests({ historyDbPath: ":memory:" })
  await initHistory(true, 200)
})

afterEach(async () => {
  clearHistory()
  await shutdownHistory()
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
})

describe("retired archive surface", () => {
  test("archive mutation endpoints are not registered", async () => {
    expect((await post("/api/archive-now")).status).toBe(404)
    expect((await post("/api/archive-cooldown")).status).toBe(404)
  })

  test("tier=archive is rejected instead of silently reading HOT", async () => {
    expect((await get("/api/entries?tier=archive")).status).toBe(400)
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

describe("search endpoint: sidecar-forwarded contract (no sidecar reachable in this test's environment)", () => {
  test("degrades to an empty, partial result when the sidecar is unreachable — 200, never 500, never a crash", async () => {
    // See tests/history/search/search-rest-cutover.it.test.ts for the REAL,
    // end-to-end sidecar-reachable path (a genuine UDS server on a temp
    // socket) — this file's fixture never points PATHS.HISTORY_SEARCH_SOCKET
    // at a real listener, so this exercises the "sidecar not installed/
    // running" degrade path, which is the common production case for an
    // operator who has not set up the optional service (docs/deploy/).
    const search = await get("/api/search?source=inbound&q=needle")
    expect(search.status).toBe(200)
    expect(await json<{ rows: Array<unknown>; partial: boolean }>(search)).toMatchObject({ rows: [], partial: true })

    const contains = await get("/api/search/contains?hash=deadbeef")
    expect(contains.status).toBe(200)
    expect(await json<{ hash: string; reqIds: Array<string> }>(contains)).toEqual({ hash: "deadbeef", reqIds: [] })
  })

  test("a facet other than inbound always returns empty + partial, even if it were reachable", async () => {
    const search = await get("/api/search?source=rewrites-req&q=needle")
    expect(search.status).toBe(200)
    expect(await json<{ rows: Array<unknown>; partial: boolean }>(search)).toMatchObject({ rows: [], partial: true })
  })
})

// ─── sessions API ───
