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
import { insertCompletedEntry } from "~/lib/history/sqlite/write"

/** Entry carrying the given user-message text (drives preview_text + the search index). */
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

describe("entries_v2 supplemental indexes", () => {
  beforeEach(async () => {
    closeDatabase()
    openInMemoryDatabase()
  })

  test("endpoint and partial-active indexes exist", async () => {
    const names = (getDatabase().prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='entries_v2'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    )
    expect(names).toContain("idx_entries_v2_endpoint")
    expect(names).toContain("idx_entries_v2_active")
  })

  test("partial-active index serves the stale-active reclaim scan", async () => {
    const plan = getDatabase()
      .prepare("EXPLAIN QUERY PLAN UPDATE entries_v2 SET status='interrupted' WHERE status IN ('pending','executing','streaming') AND pid=? AND started_at<?")
      .all(1, 1) as Array<{ detail: string }>
    expect(plan.map((p) => p.detail).join(" | ")).toContain("idx_entries_v2_active")
  })

  test("runOptimize is callable and idempotent", async () => {
    await insertCompletedEntry(makeEntry("a", "optimize me"))
    expect(() => {
      runOptimize(getDatabase())
      runOptimize(getDatabase())
    }).not.toThrow()
  })
})
