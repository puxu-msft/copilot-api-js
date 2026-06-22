import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  HistoryEntry,
  RequestLifecycleState,
} from "~/lib/history/types"

import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
  runOptimize,
} from "~/lib/history/sqlite/connection"
import {
  //
  queryEntries,
  queryEntryCount,
} from "~/lib/history/sqlite/read"
import {
  //
  clearAllEntries,
  insertCompletedEntry,
} from "~/lib/history/sqlite/write"

/** Entry whose search_text carries the given message text (extractSearchText pulls message content). */
function makeEntry(id: string, text: string, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    endpoint: "anthropic-messages",
    startedAt: Date.now(),
    endedAt: Date.now() + 1,
    durationMs: 1,
    state: "completed" as RequestLifecycleState,
    active: false,
    lastUpdatedAt: Date.now() + 1,
    transport: "http",
    inboundRequest: { model: "claude-opus-4-8", messages: [{ role: "user", content: text }] },
    outboundResponse: {
      success: true,
      model: "claude-opus-4-8",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: { role: "assistant", content: "ok" },
    },
    ...overrides,
  } as HistoryEntry
}

function searchIds(needle: string): Array<string> {
  return queryEntries({ search: needle }).map((e) => e.id)
}

describe("entries_v2 search (trigram FTS5)", () => {
  beforeEach(() => {
    closeDatabase()
    openInMemoryDatabase()
  })

  test("≥3-char substring search returns matching entries via FTS", () => {
    insertCompletedEntry(makeEntry("a", "the quick brown fox jumps"))
    insertCompletedEntry(makeEntry("b", "nothing relevant here"))
    expect(searchIds("brown").sort()).toEqual(["a"])
    expect(searchIds("quick")).toEqual(["a"])
    expect(searchIds("zzz")).toEqual([])
  })

  test("mid-word substring matches (trigram, not token boundary)", () => {
    insertCompletedEntry(makeEntry("a", "calling tool_result now"))
    // 'ool_resul' is a mid-word fragment a plain token search would miss.
    expect(searchIds("ool_resul")).toEqual(["a"])
    expect(searchIds("tool_result")).toEqual(["a"])
  })

  test("the FTS query plan uses the FTS index, not a table scan", () => {
    insertCompletedEntry(makeEntry("a", "indexed lookup path"))
    const plan = getDatabase()
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM entries_v2 WHERE rowid IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?) ORDER BY started_at DESC")
      .all('"indexed"') as Array<{ detail: string }>
    const text = plan.map((p) => p.detail).join(" | ")
    expect(text).toContain("entries_fts")
  })

  test("sub-3-char needle falls back to LIKE and still matches", () => {
    insertCompletedEntry(makeEntry("a", "ab cd ef"))
    // 'ab' is only 2 chars — trigram can't index it; the LIKE fallback covers it.
    expect(searchIds("ab")).toEqual(["a"])
    expect(searchIds("xy")).toEqual([])
  })

  test("delete removes the row from the FTS index (no stale matches)", () => {
    insertCompletedEntry(makeEntry("a", "ephemeral content marker"))
    expect(searchIds("ephemeral")).toEqual(["a"])
    clearAllEntries()
    expect(searchIds("ephemeral")).toEqual([])
    // FTS index itself must be empty, not just entries_v2.
    const { n } = getDatabase().prepare("SELECT COUNT(*) AS n FROM entries_fts").get() as { n: number }
    expect(n).toBe(0)
  })

  test("re-insert (upsert) keeps the FTS index in sync — old terms drop, new terms match", () => {
    insertCompletedEntry(makeEntry("a", "original alpha phrase"))
    expect(searchIds("alpha")).toEqual(["a"])
    // Same id, different content → ON CONFLICT DO UPDATE → AFTER UPDATE trigger.
    insertCompletedEntry(makeEntry("a", "replaced beta phrase"))
    expect(searchIds("alpha")).toEqual([])
    expect(searchIds("beta")).toEqual(["a"])
    // Still exactly one entry (upsert, not duplicate).
    expect(queryEntryCount()).toBe(1)
  })

  test("'rebuild' repopulates the FTS index from entries_v2 (backfill path)", () => {
    insertCompletedEntry(makeEntry("a", "rebuildable haystack needle"))
    const db = getDatabase()
    // Simulate a stale/empty index (as on a DB that predates FTS, or post-VACUUM).
    db.exec("INSERT INTO entries_fts(entries_fts) VALUES('delete-all')")
    expect(searchIds("haystack")).toEqual([])
    db.exec("INSERT INTO entries_fts(entries_fts) VALUES('rebuild')")
    expect(searchIds("haystack")).toEqual(["a"])
  })

  test("search composes with other filters (AND)", () => {
    insertCompletedEntry(makeEntry("a", "shared keyword", { endpoint: "anthropic-messages" }))
    insertCompletedEntry(makeEntry("b", "shared keyword", { endpoint: "openai-chat-completions" }))
    expect(queryEntries({ search: "shared", endpoint: "openai-chat-completions" }).map((e) => e.id)).toEqual(["b"])
  })
})

describe("entries_v2 supplemental indexes", () => {
  beforeEach(() => {
    closeDatabase()
    openInMemoryDatabase()
  })

  test("endpoint and partial-active indexes exist", () => {
    const names = (getDatabase().prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='entries_v2'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    )
    expect(names).toContain("idx_entries_v2_endpoint")
    expect(names).toContain("idx_entries_v2_active")
  })

  test("partial-active index serves the stale-active reclaim scan", () => {
    const plan = getDatabase()
      .prepare("EXPLAIN QUERY PLAN UPDATE entries_v2 SET status='interrupted' WHERE status IN ('pending','executing','streaming') AND pid=? AND started_at<?")
      .all(1, 1) as Array<{ detail: string }>
    expect(plan.map((p) => p.detail).join(" | ")).toContain("idx_entries_v2_active")
  })

  test("runOptimize is callable and idempotent", () => {
    insertCompletedEntry(makeEntry("a", "optimize me"))
    expect(() => {
      runOptimize(getDatabase())
      runOptimize(getDatabase())
    }).not.toThrow()
  })
})
