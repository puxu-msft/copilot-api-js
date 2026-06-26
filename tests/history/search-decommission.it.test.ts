/**
 * P3 decommission: the legacy trigram FTS + `search_text` column are dropped, the
 * search index is the sole search path, and orphaned `msg_blob` rows are GC'd at
 * every delete site (reaper / deleteSession / clearAll).
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
  deleteSession,
  finalizeEntry,
  insertEntry,
  updateEntry,
} from "~/lib/history"
import { getDatabase } from "~/lib/history/sqlite/connection"
import { runReaperOnce } from "~/lib/history/sqlite/reaper"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

function seed(id: string, messages: Array<MessageContent>, startedAt: number, sessionId = "s"): void {
  const entry = { id, sessionId, startedAt, endpoint: "anthropic-messages", inboundRequest: { model: "m", messages, stream: true } } as unknown as HistoryEntry
  insertEntry(entry)
  updateEntry(id, { state: "completed", outboundResponse: { success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: null } })
  finalizeEntry(id)
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

  test("a fresh DB has no entries_fts table and no search_text column", () => {
    expect(tableExists("entries_fts")).toBe(false)
    expect(columnExists("entries_v2", "search_text")).toBe(false)
  })

  test("finalize works (no search_text reference) and writes the index", () => {
    expect(() => seed("f1", [{ role: "user", content: "decommission probe" }], 1000)).not.toThrow()
    const n = (getDatabase().prepare("SELECT COUNT(*) AS n FROM req_msg WHERE req_id = 'f1'").get() as { n: number }).n
    expect(n).toBe(1)
  })

  test("deleteSession GCs the now-orphaned msg_blob rows", () => {
    seed("d1", [{ role: "user", content: "session-unique-A" }], 1000, "sA")
    seed("d2", [{ role: "user", content: "session-unique-B" }], 2000, "sB")
    expect(blobCount()).toBe(2)
    deleteSession("sA")
    // d1's blob is now orphaned (no req_msg) → swept; d2's remains.
    expect(blobCount()).toBe(1)
  })

  test("deleteSession keeps a blob still referenced by another session", () => {
    const shared: MessageContent = { role: "user", content: "shared-across-sessions" }
    seed("k1", [shared], 1000, "sX")
    seed("k2", [shared], 2000, "sY")
    expect(blobCount()).toBe(1) // content-addressed dedup
    deleteSession("sX")
    // k2 (session sY) still references the blob → NOT swept.
    expect(blobCount()).toBe(1)
  })

  test("clearHistory wipes msg_blob + req_aux entirely", () => {
    seed("c1", [{ role: "user", content: "to be cleared" }], 1000)
    expect(blobCount()).toBeGreaterThan(0)
    clearHistory()
    expect(blobCount()).toBe(0)
    expect((getDatabase().prepare("SELECT COUNT(*) AS n FROM req_aux").get() as { n: number }).n).toBe(0)
  })

  test("reaper eviction GCs orphaned blobs (gated on a real eviction)", () => {
    // success limit 1 → seeding 3 success rows evicts 2 oldest.
    seed("r0", [{ role: "user", content: "reaper-row-0" }], 1000)
    seed("r1", [{ role: "user", content: "reaper-row-1" }], 2000)
    seed("r2", [{ role: "user", content: "reaper-row-2" }], 3000)
    expect(blobCount()).toBe(3)
    const evicted = runReaperOnce(1, 200)
    expect(evicted).toBe(2)
    // The 2 evicted rows' blobs are orphaned → swept; the surviving row's blob stays.
    expect(blobCount()).toBe(1)
  })

  test("reopening the DB does not resurrect the search_text column", () => {
    // The migrate `wanted` no longer includes search_text; a re-open must not re-add it.
    seed("re1", [{ role: "user", content: "x" }], 1000)
    expect(columnExists("entries_v2", "search_text")).toBe(false)
  })
})
