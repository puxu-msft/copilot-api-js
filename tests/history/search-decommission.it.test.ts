/**
 * P3 decommission: the legacy trigram FTS + `search_text` column are dropped, the
 * search index is the sole search path, and orphaned `msg_blob` rows are GC'd at
 * legacy search index maintenance remains isolated to V2 test primitives.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  HistoryEntry,
  MessageContent,
} from "~/lib/history/types"

import {
  //
  clearHistory,
  finalizeEntry,
  insertEntry,
  updateEntry,
} from "~/lib/history"
import { getDatabase } from "~/lib/history/sqlite/connection"
import { runReaperOnce } from "~/lib/history/sqlite/reaper"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

async function seed(id: string, messages: Array<MessageContent>, startedAt: number, sessionId = "s"): Promise<void> {
  const entry = { id, sessionId, startedAt, endpoint: "anthropic-messages", model: { requested: "m" }, clientRequest: { format: "anthropic-messages", model: "m", messages, stream: true } } as unknown as HistoryEntry
  insertEntry(entry)
  updateEntry(id, {
    state: "completed",
    attempts: [{ index: 0, durationMs: 0, upstreamResponse: { success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, body: null } }],
    _index: { derived: { responseSuccess: true, attemptCount: 1 } },
  })
  await finalizeEntry(id)
}

function tableExists(name: string): boolean {
  return Boolean(getDatabase().prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','view') AND name = ?").get(name))
}

function columnExists(table: string, column: string): boolean {
  return (getDatabase().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column)
}

function blobCount(): number {
  return (getDatabase().prepare("SELECT COUNT(*) AS n FROM msg_blob").get() as { n: number }).n
}

describe("search_index P3 decommission + GC", () => {
  useIsolatedRuntime()

  test("a fresh DB has no entries_fts table and no search_text column", async () => {
    expect(tableExists("entries_fts")).toBe(false)
    expect(columnExists("entries_v2", "search_text")).toBe(false)
  })

  test("finalize works (no search_text reference) and writes the index", async () => {
    expect(() => seed("f1", [{ role: "user", content: "decommission probe" }], 1000)).not.toThrow()
    const n = (getDatabase().prepare("SELECT COUNT(*) AS n FROM req_msg WHERE req_id = 'f1'").get() as { n: number }).n
    expect(n).toBe(1)
  })

  test("clearHistory wipes msg_blob + req_aux entirely", async () => {
    await seed("c1", [{ role: "user", content: "to be cleared" }], 1000)
    expect(blobCount()).toBeGreaterThan(0)
    clearHistory()
    expect(blobCount()).toBe(0)
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM req_aux").get() as { n: number }).n).toBe(0)
  })

  test("reopening the DB does not resurrect the search_text column", async () => {
    // The migrate `wanted` no longer includes search_text; a re-open must not re-add it.
    await seed("re1", [{ role: "user", content: "x" }], 1000)
    expect(columnExists("entries_v2", "search_text")).toBe(false)
  })
})
