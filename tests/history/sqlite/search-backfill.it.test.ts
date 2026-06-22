import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type {
  //
  HistoryEntry,
  RequestLifecycleState,
} from "~/lib/history/types"

import {
  //
  closeDatabase,
  getDatabase,
  openDatabase,
} from "~/lib/history/sqlite/connection"
import { queryEntries } from "~/lib/history/sqlite/read"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"

const tmpDirs: Array<string> = []
function freshDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-fts-backfill-"))
  tmpDirs.push(dir)
  return path.join(dir, "history.db")
}

afterEach(() => {
  closeDatabase()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function makeEntry(id: string, text: string): HistoryEntry {
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
    outboundResponse: { success: true, model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1 }, content: { role: "assistant", content: "ok" } },
  } as HistoryEntry
}

/** Drop the FTS table + triggers to mimic a database that predates the search index. */
function stripFtsIndex(): void {
  const db = getDatabase()
  db.exec("DROP TRIGGER IF EXISTS entries_v2_fts_ai")
  db.exec("DROP TRIGGER IF EXISTS entries_v2_fts_ad")
  db.exec("DROP TRIGGER IF EXISTS entries_v2_fts_au")
  db.exec("DROP TABLE IF EXISTS entries_fts")
}

describe("sqlite/search backfill (pre-FTS upgrade path)", () => {
  test("reopening a DB whose rows predate the FTS index backfills and makes them searchable", () => {
    const dbPath = freshDbPath()

    openDatabase(dbPath)
    insertCompletedEntry(makeEntry("a", "predates the index haystack one"))
    insertCompletedEntry(makeEntry("b", "predates the index haystack two"))
    // Simulate a pre-FTS database: entries_v2 has rows, the FTS index is absent.
    // (Production never queries in this state — open always (re)creates the
    // index before any read — so this stands in for "rows written by an older
    // build that had no FTS index".)
    stripFtsIndex()
    closeDatabase()

    // Reopen — ensureSearchIndex must detect the absent index and backfill the
    // existing rows (NOT skip on a content-table COUNT readthrough).
    openDatabase(dbPath)
    const ids = queryEntries({ search: "haystack" })
      .map((e) => e.id)
      .sort()
    expect(ids).toEqual(["a", "b"])
  })

  test("a second reopen does NOT re-backfill but search still works (triggers maintain it)", () => {
    const dbPath = freshDbPath()
    openDatabase(dbPath)
    insertCompletedEntry(makeEntry("a", "stable searchable content"))
    closeDatabase()

    openDatabase(dbPath) // index already present from first open
    insertCompletedEntry(makeEntry("b", "added searchable content after reopen"))
    expect(
      queryEntries({ search: "searchable" })
        .map((e) => e.id)
        .sort(),
    ).toEqual(["a", "b"])
  })
})
