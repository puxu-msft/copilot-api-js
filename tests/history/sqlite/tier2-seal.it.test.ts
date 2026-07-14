/**
 * TIER-1 → TIER-2 sealing (spec §3.2/§M1, Phase 0 verdict: SQLite sealed +
 * session-group). Seals the oldest tier-1 sessions into immutable numbered cold
 * units when archive.db exceeds the size cap; manifest-write + tier-1-delete are
 * one atomic archive.db transaction; readback round-trips via the manifest locator.
 *
 * Harness: seed HOT via insertCompletedEntry (valid blobs + search index), ATTACH
 * a real archive.db, MOVE entries into tier-1, then seal — so the sealed entries
 * are genuine assembled HistoryEntry objects (not hand-crafted).
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

import { closeArchiveDb, getArchiveDb, openArchiveDb } from "~/lib/history/sqlite/archive-db"
import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { migrateEntriesToTier1 } from "~/lib/history/sqlite/tier1-migrate"
import { readTier2Entry, runTier2SealOnce, sealSession } from "~/lib/history/sqlite/tier2-seal"
import { querySummaries } from "~/lib/history/sqlite/read"
import { getEntry } from "~/lib/history/queries"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"
import { setStateForTests } from "~/lib/state"

let dir: string

async function seedHotThenMove(id: string, sessionId: string, text: string): Promise<void> {
  await insertCompletedEntry({
    id,
    sessionId,
    endpoint: "anthropic-messages",
    startedAt: Number(id.replace(/\D/g, "")) || 1000,
    endedAt: 3000,
    durationMs: 0,
    state: "completed" as RequestLifecycleState,
    active: false,
    lastUpdatedAt: 3000,
    transport: "http",
    clientRequest: { model: "m", messages: [{ role: "user", content: text }] },
    inboundRequest: { model: "m", messages: [{ role: "user", content: text }] },
    outboundResponse: { success: true, model: "m", usage: { input_tokens: 0, output_tokens: 0 }, content: null },
  } as HistoryEntry)
}

const archiveCount = () => (getArchiveDb().prepare("SELECT COUNT(*) n FROM entries_v2").get() as { n: number }).n
const manifestCount = () => (getArchiveDb().prepare("SELECT COUNT(*) n FROM tier2_manifest").get() as { n: number }).n

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier2-seal-test-"))
  setStateForTests({ historyDbPath: ":memory:", historyArchiveEnabled: true, historyArchiveDir: dir, historyArchiveTier1SizeCap: 0 })
  closeDatabase()
  openInMemoryDatabase()
  openArchiveDb(path.join(dir, "archive.db"))
  closeArchiveDb()
  getDatabase().prepare("ATTACH DATABASE ? AS archive").run(path.join(dir, "archive.db"))
  // seed two sessions into HOT and move them all into tier-1
  await seedHotThenMove("s1a1000", "sess-1", "session one first")
  await seedHotThenMove("s1b2000", "sess-1", "session one second")
  await seedHotThenMove("s2a3000", "sess-2", "session two")
  migrateEntriesToTier1(getDatabase(), ["s1a1000", "s1b2000", "s2a3000"])
  // re-open the standalone archive connection the seal path reads/writes through
  openArchiveDb(path.join(dir, "archive.db"))
})

afterEach(() => {
  closeDatabase()
  closeArchiveDb()
  setStateForTests({ historyDbPath: "", historyArchiveDir: "", historyArchiveTier1SizeCap: 2 * 1024 * 1024 * 1024 })
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("tier2 seal — session-group sealed units", () => {
  test("sealSession moves a whole session tier-1 → tier-2 (manifest + removed from tier-1)", () => {
    expect(archiveCount()).toBe(3) // all three in tier-1

    const sealed = sealSession("sess-1", dir)
    expect(sealed).toBe(2) // sess-1 had 2 entries

    // sess-1 rows gone from tier-1, present in manifest; sess-2 untouched
    expect(archiveCount()).toBe(1)
    expect(manifestCount()).toBe(2)
    // a numbered seal file exists
    expect(fs.readdirSync(dir).some((f) => /^archive-\d{4}\.db$/.test(f))).toBe(true)
  })

  test("readTier2Entry round-trips a sealed entry via the manifest locator", () => {
    sealSession("sess-1", dir)
    const back = readTier2Entry("s1a1000")
    expect(back?.id).toBe("s1a1000")
    // the client request message survived the session-group zstd round-trip
    expect(back?.clientRequest?.messages?.[0]?.content).toBe("session one first")
    const back2 = readTier2Entry("s1b2000")
    expect(back2?.id).toBe("s1b2000")
  })

  test("runTier2SealOnce seals until under the size cap (cap=0 → seal everything)", () => {
    const sealed = runTier2SealOnce()
    expect(sealed).toBe(3) // both sessions sealed
    expect(archiveCount()).toBe(0) // tier-1 drained
    expect(manifestCount()).toBe(3)
  })

  test("idempotent: re-sealing after all rows moved is a no-op (no duplicate manifest rows)", () => {
    runTier2SealOnce()
    const before = manifestCount()
    const again = runTier2SealOnce()
    expect(again).toBe(0)
    expect(manifestCount()).toBe(before)
  })

  test("manifest carries searchable meta (model / status / started_at) for the archive list view", () => {
    sealSession("sess-2", dir)
    const row = getArchiveDb().prepare("SELECT entry_id, model, status, started_at, seal_file, index_in_session FROM tier2_manifest WHERE entry_id = 's2a3000'").get() as Record<string, unknown>
    expect(row.entry_id).toBe("s2a3000")
    expect(row.status).toBe("completed")
    expect(row.model).toBe("m")
    expect(typeof row.seal_file).toBe("string")
    expect(row.index_in_session).toBe(0)
  })

  test("archive view list includes tier-2 sealed entries (UNION manifest); detail reads them", () => {
    sealSession("sess-1", dir) // sess-1 → tier-2; sess-2 stays tier-1
    // archive list (tier=archive) surfaces BOTH tier-1 (sess-2) and tier-2 (sess-1) rows
    const ids = querySummaries({ tier: "archive", limit: 100 }).map((s) => s.id).sort()
    expect(ids).toEqual(["s1a1000", "s1b2000", "s2a3000"])
    // a sealed entry's detail resolves through the manifest → seal unit
    expect(getEntry("s1a1000", "archive")?.clientRequest?.messages?.[0]?.content).toBe("session one first")
    // a still-tier-1 entry resolves directly
    expect(getEntry("s2a3000", "archive")?.id).toBe("s2a3000")
  })

  test("archive list model filter matches sealed manifest rows", () => {
    runTier2SealOnce() // seal everything
    expect(querySummaries({ tier: "archive", model: "m", limit: 100 })).toHaveLength(3)
    expect(querySummaries({ tier: "archive", model: "nonexistent", limit: 100 })).toHaveLength(0)
  })
})
