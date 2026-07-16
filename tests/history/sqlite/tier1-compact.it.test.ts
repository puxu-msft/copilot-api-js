/**
 * TIER-1 per-session compaction: moves each tier-1 session's heavy stages out of
 * archive.db into a per-session columnar file (archive-t1-<session>.db) + a
 * tier1_locator row, keeping the summary head in archive.entries_v2 as the index.
 * Detail reads resolve through the file; the list view is unchanged.
 *
 * Harness mirrors tier2-seal.it: seed HOT via insertCompletedEntry, ATTACH a real
 * archive.db, MOVE entries into tier-1, then compact.
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

import type { ArchiveWorkerControl } from "~/lib/history/sqlite/archive-worker"
import type {
  //
  HistoryEntry,
  RequestLifecycleState,
} from "~/lib/history/types"

import { getEntry } from "~/lib/history/queries"
import {
  //
  closeArchiveDb,
  getArchiveDb,
  openArchiveDb,
} from "~/lib/history/sqlite/archive-db"
import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { querySummaries } from "~/lib/history/sqlite/read"
import {
  //
  compactTier1Session,
  runTier1CompactOnce,
} from "~/lib/history/sqlite/tier1-compact"
import { migrateEntriesToTier1 } from "~/lib/history/sqlite/tier1-migrate"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"
import { setStateForTests } from "~/lib/state"

let dir: string

async function seedHotThenMove(id: string, sessionId: string, text: string): Promise<void> {
  await insertCompletedEntry({
    id,
    sessionId,
    endpoint: "anthropic-messages",
    startedAt: Number(id.replaceAll(/\D/g, "")) || 1000,
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

const archiveStageRows = () => (getArchiveDb().prepare("SELECT COUNT(*) n FROM entry_stages").get() as { n: number }).n
const locatorRows = () => (getArchiveDb().prepare("SELECT COUNT(*) n FROM tier1_locator").get() as { n: number }).n

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier1-compact-test-"))
  setStateForTests({ historyDbPath: ":memory:", historyArchiveEnabled: true, historyArchiveDir: dir, historyArchiveTier1SizeCap: 2 * 1024 * 1024 * 1024 })
  closeDatabase()
  openInMemoryDatabase()
  openArchiveDb(path.join(dir, "archive.db"))
  closeArchiveDb()
  getDatabase().prepare("ATTACH DATABASE ? AS archive").run(path.join(dir, "archive.db"))
  await seedHotThenMove("s1a1000", "sess-1", "session one first")
  await seedHotThenMove("s1b2000", "sess-1", "session one second")
  await seedHotThenMove("s2a3000", "sess-2", "session two")
  migrateEntriesToTier1(getDatabase(), ["s1a1000", "s1b2000", "s2a3000"])
  openArchiveDb(path.join(dir, "archive.db"))
})

afterEach(() => {
  closeDatabase()
  closeArchiveDb()
  setStateForTests({ historyDbPath: "", historyArchiveDir: "", historyArchiveTier1SizeCap: 2 * 1024 * 1024 * 1024 })
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("tier1 compaction — per-session columnar files", () => {
  test("compactTier1Session moves a session's stages into its own file + locator", async () => {
    expect(archiveStageRows()).toBeGreaterThan(0) // stages present pre-compaction

    const { entries } = await compactTier1Session("sess-1", dir)
    expect(entries).toBe(2)

    // sess-1's stages are gone from archive.db; sess-2 untouched; locators recorded
    expect(locatorRows()).toBe(2)
    expect(fs.readdirSync(dir).some((f) => /^archive-t1-.+\.db$/.test(f))).toBe(true)
    // head rows stay in archive.entries_v2 (the index)
    expect((getArchiveDb().prepare("SELECT COUNT(*) n FROM entries_v2").get() as { n: number }).n).toBe(3)
  })

  test("detail read of a compacted entry resolves through the columnar file", async () => {
    await compactTier1Session("sess-1", dir)
    // stages deleted from archive.db, yet the full detail still round-trips via the file
    expect(getEntry("s1a1000", "archive")?.clientRequest?.messages?.[0]?.content).toBe("session one first")
    expect(getEntry("s1b2000", "archive")?.clientRequest?.messages?.[0]?.content).toBe("session one second")
    // a NOT-yet-compacted tier-1 entry still resolves from stages
    expect(getEntry("s2a3000", "archive")?.clientRequest?.messages?.[0]?.content).toBe("session two")
  })

  test("runTier1CompactOnce compacts all sessions; list view stays intact", async () => {
    const n = await runTier1CompactOnce()
    expect(n).toBe(3)
    expect(archiveStageRows()).toBe(0) // all heavy stages moved out of archive.db
    expect(locatorRows()).toBe(3)
    // archive list still lists all three (head rows are the index)
    const ids = querySummaries({ tier: "archive", limit: 100 })
      .map((s) => s.id)
      .sort()
    expect(ids).toEqual(["s1a1000", "s1b2000", "s2a3000"])
    // idempotent: a second pass finds nothing to do
    expect(await runTier1CompactOnce()).toBe(0)
  })

  test("shutdown checkpoint completes one session, then the next pass resumes", async () => {
    let stop = false
    const control: ArchiveWorkerControl = {
      shouldStop: () => stop,
      async checkpoint() {
        stop = true
        return true
      },
    }

    expect(await runTier1CompactOnce({ control, concurrency: 1 })).toBe(2)
    expect(locatorRows()).toBe(2)
    expect(archiveStageRows()).toBeGreaterThan(0)

    expect(await runTier1CompactOnce({ concurrency: 1 })).toBe(1)
    expect(locatorRows()).toBe(3)
    expect(archiveStageRows()).toBe(0)
  })

  test("later entries in an already-compacted session create a new immutable unit", async () => {
    await compactTier1Session("sess-2", dir)
    const first = getArchiveDb().prepare("SELECT seal_file FROM tier1_locator WHERE entry_id = 's2a3000'").get() as { seal_file: string }
    expect(getEntry("s2a3000", "archive")?.clientRequest?.messages?.[0]?.content).toBe("session two")

    await seedHotThenMove("s2b4000", "sess-2", "session two later")
    migrateEntriesToTier1(getDatabase(), ["s2b4000"])
    await compactTier1Session("sess-2", dir)

    const second = getArchiveDb().prepare("SELECT seal_file FROM tier1_locator WHERE entry_id = 's2b4000'").get() as { seal_file: string }
    expect(second.seal_file).not.toBe(first.seal_file)
    expect(fs.existsSync(path.join(dir, first.seal_file))).toBe(false)
    expect(fs.existsSync(path.join(dir, second.seal_file))).toBe(true)
    expect(getEntry("s2a3000", "archive")?.clientRequest?.messages?.[0]?.content).toBe("session two")
    expect(getEntry("s2b4000", "archive")?.clientRequest?.messages?.[0]?.content).toBe("session two later")
  })
})
