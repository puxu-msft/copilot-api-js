/**
 * Read-path view-domain split (spec §2/§4): the SAME query functions route to the
 * HOT store (history.db, default) or the archive VIEW (archive.db, tier="archive")
 * and NEVER co-list. Covers list / detail / count / deep search across the split.
 *
 * Harness: the module-global HOT db (in-memory) + a file-based archive.db whose
 * OWN connection (getArchiveDb) is what tier="archive" reads. A HOT row and an
 * archive row with distinct ids prove neither view leaks into the other.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { HistoryEntry, RequestLifecycleState } from "~/lib/history/types"

import { closeArchiveDb, openArchiveDb } from "~/lib/history/sqlite/archive-db"
import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { getEntry } from "~/lib/history/queries"
import { getEntryById, queryEntryCount, querySummaries } from "~/lib/history/sqlite/read"
import { searchHistory } from "~/lib/history/search"
import { moveEntryToTier1 } from "~/lib/history/sqlite/tier1-migrate"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"

let dir: string

async function seedHot(id: string, text: string): Promise<void> {
  await insertCompletedEntry({
    id,
    endpoint: "anthropic-messages",
    startedAt: id === "hot-1" ? 1000 : 2000,
    endedAt: 3000,
    durationMs: 0,
    state: "completed" as RequestLifecycleState,
    active: false,
    lastUpdatedAt: 3000,
    transport: "http",
    clientRequest: { model: id === "hot-1" ? "hot-model" : "arch-model", messages: [{ role: "user", content: text }] },
    inboundRequest: { model: id === "hot-1" ? "hot-model" : "arch-model", messages: [{ role: "user", content: text }] },
    outboundResponse: { success: true, model: "m", usage: { input_tokens: 0, output_tokens: 0 }, content: null },
  } as HistoryEntry)
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-tier-test-"))
  closeDatabase()
  openInMemoryDatabase()
  // real archive.db file with the shared schema; ATTACH it to the HOT connection
  // so a real move produces valid archive rows (valid head blob + search index).
  openArchiveDb(path.join(dir, "archive.db"))
  closeArchiveDb()
  getDatabase().prepare("ATTACH DATABASE ? AS archive").run(path.join(dir, "archive.db"))
  // seed two HOT entries; move one into archive (the archive VIEW reads it via its
  // own connection, re-opened below).
  await seedHot("hot-1", "hello from hot")
  await seedHot("arch-1", "hello from archive")
  expect(moveEntryToTier1(getDatabase(), "arch-1")).toBe(true)
  // re-open the standalone archive connection that tier="archive" reads through
  // (same file the move just wrote via ATTACH).
  openArchiveDb(path.join(dir, "archive.db"))
})

afterEach(() => {
  closeDatabase()
  closeArchiveDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("read-path view-domain split", () => {
  test("list: hot view lists only HOT, archive view lists only archive", () => {
    const hotIds = querySummaries({ limit: 100 }).map((s) => s.id)
    expect(hotIds).toContain("hot-1")
    expect(hotIds).not.toContain("arch-1")

    const archIds = querySummaries({ tier: "archive", limit: 100 }).map((s) => s.id)
    expect(archIds).toContain("arch-1")
    expect(archIds).not.toContain("hot-1")
  })

  test("count: each view counts only its own store", () => {
    expect(queryEntryCount()).toBe(1)
    expect(queryEntryCount({ tier: "archive" })).toBe(1)
  })

  test("detail: getEntryById routes by tier", () => {
    expect(getEntryById("hot-1")?.id).toBe("hot-1")
    expect(getEntryById("arch-1")).toBeUndefined() // not in HOT
    expect(getEntryById("arch-1", "archive")?.id).toBe("arch-1")
    expect(getEntryById("hot-1", "archive")).toBeUndefined() // not in archive
  })

  test("getEntry (queries.ts) archive tier skips in-flight and reads archive", () => {
    expect(getEntry("arch-1", "archive")?.id).toBe("arch-1")
    expect(getEntry("hot-1")?.id).toBe("hot-1")
    expect(getEntry("arch-1")).toBeUndefined() // hot view can't see archive
  })

  test("deep search: archive tier finds archive messages, hot tier finds hot messages, no cross-leak", () => {
    const hotHit = searchHistory({ source: "inbound", q: "from hot" })
    expect(hotHit.rows.map((r) => r.ownerReqId)).toContain("hot-1")

    const archHit = searchHistory({ source: "inbound", q: "from archive", filters: { tier: "archive" } })
    expect(archHit.rows.map((r) => r.ownerReqId)).toContain("arch-1")

    // cross-domain: hot needle not found in archive view, archive needle not in hot view
    expect(searchHistory({ source: "inbound", q: "from hot", filters: { tier: "archive" } }).rows).toHaveLength(0)
    expect(searchHistory({ source: "inbound", q: "from archive" }).rows).toHaveLength(0)
  })
})
