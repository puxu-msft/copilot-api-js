import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  getEntryById,
  querySummaries,
} from "~/lib/history/sqlite/read"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    endpoint: "anthropic-messages",
    startedAt: Date.now(),
    endedAt: Date.now() + 100,
    durationMs: 100,
    state: "completed",
    active: false,
    lastUpdatedAt: Date.now() + 100,
    transport: "http",
    inboundRequest: { model: "claude-opus-4-7" },
    outboundResponse: {
      success: true,
      model: "claude-opus-4-7",
      usage: { input_tokens: 1, output_tokens: 2 },
      content: { role: "assistant", content: "ok" },
    },
    ...overrides,
  } as HistoryEntry
}

describe("history raw_path column", () => {
  beforeEach(async () => {
    closeDatabase()
    openInMemoryDatabase()
  })

  test("CRITICAL: rawPath is written to the raw_path column, not just the blob", async () => {
    // Regression guard: the request URL path (`entry.rawPath`) was captured in-flight
    // but never persisted to a terminal column, so the terminal SUMMARY (list) path
    // — which reads columns, not the blob — showed the mangled endpoint enum instead
    // of the real `/v1/messages`. Assert the raw column directly.
    await insertCompletedEntry(makeEntry({ id: "with-path", rawPath: "/v1/messages" }))

    const db = getDatabase()
    const row = db.prepare("SELECT raw_path FROM entries_v2 WHERE id = ?").get("with-path") as { raw_path: string | null }
    expect(row.raw_path).toBe("/v1/messages")
  })

  test("CRITICAL: the terminal SUMMARY (list) path surfaces rawPath (the actual bug)", async () => {
    // The list/summary uses querySummaries → rowToSummary from SQL columns (no blob
    // decode). Before the fix rawPath was absent here → endpointLabel fell back to the
    // enum. This is the user-facing symptom guard.
    await insertCompletedEntry(makeEntry({ id: "sum-path", rawPath: "/v1/messages" }))

    const summaries = querySummaries({ limit: 10 })
    const got = summaries.find((s) => s.id === "sum-path")
    expect(got?.rawPath).toBe("/v1/messages")
  })

  test("rawPath round-trips through the blob for the full entry", async () => {
    await insertCompletedEntry(makeEntry({ id: "full-path", rawPath: "/v1/messages" }))
    const got = getEntryById("full-path")
    expect(got?.rawPath).toBe("/v1/messages")
  })

  test("an entry with no rawPath stores NULL and surfaces undefined in the summary", async () => {
    await insertCompletedEntry(makeEntry({ id: "no-path" }))
    const db = getDatabase()
    const row = db.prepare("SELECT raw_path FROM entries_v2 WHERE id = ?").get("no-path") as { raw_path: string | null }
    expect(row.raw_path).toBeNull()

    const got = querySummaries({ limit: 10 }).find((s) => s.id === "no-path")
    expect(got?.rawPath).toBeUndefined()
  })

  test("ON CONFLICT re-upsert updates raw_path (SET clause covered)", async () => {
    // Direct oracle for `raw_path = excluded.raw_path` in INSERT_ENTRY_SQL's ON
    // CONFLICT DO UPDATE — a re-finalization (same id) of the same request must
    // refresh the column, not keep a stale value.
    await insertCompletedEntry(makeEntry({ id: "reupsert", rawPath: "/v1/first" }))
    await insertCompletedEntry(makeEntry({ id: "reupsert", rawPath: "/v1/second" }))

    const db = getDatabase()
    const row = db.prepare("SELECT raw_path FROM entries_v2 WHERE id = ?").get("reupsert") as { raw_path: string | null }
    expect(row.raw_path).toBe("/v1/second")
    expect(querySummaries({ limit: 10 }).find((s) => s.id === "reupsert")?.rawPath).toBe("/v1/second")
  })
})
