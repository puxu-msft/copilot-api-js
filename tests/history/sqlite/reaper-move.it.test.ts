/**
 * reaper move-to-tier1 dispatch (spec §3.1/§3.5): when archiving is enabled AND
 * archive.db is attached, the reaper's count safety-valve MOVES overflow rows to
 * tier-1 instead of the legacy lossy DELETE. When disabled it falls back to DELETE.
 *
 * Exercises the real module singleton (getDatabase) + a file-based archive.db
 * ATTACHed onto the in-memory main connection, driven through runReaperOnce.
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
import { queryEntryCount } from "~/lib/history/sqlite/read"
import { runReaperOnce, runReaperTick } from "~/lib/history/sqlite/reaper"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"
import { setHistoryConfig } from "~/lib/state"

let dir: string

async function seed(n: number, status: RequestLifecycleState = "completed", startBase = 1_000): Promise<void> {
  for (let i = 0; i < n; i++) {
    const ts = startBase + i
    await insertCompletedEntry({
      id: `${status}-${i}`,
      endpoint: "anthropic-messages",
      startedAt: ts,
      endedAt: ts,
      durationMs: 0,
      state: status,
      active: false,
      lastUpdatedAt: ts,
      transport: "http",
      inboundRequest: { model: "m" },
      outboundResponse: { success: status === "completed", model: "m", usage: { input_tokens: 0, output_tokens: 0 }, content: null },
    } as HistoryEntry)
  }
}

function attachFileArchive(): void {
  const archivePath = path.join(dir, "archive.db")
  openArchiveDb(archivePath)
  closeArchiveDb()
  getDatabase().prepare("ATTACH DATABASE ? AS archive").run(archivePath)
}

const archiveCount = () => (getDatabase().prepare("SELECT COUNT(*) n FROM archive.entries_v2").get() as { n: number }).n

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "reaper-move-test-"))
  closeDatabase()
  openInMemoryDatabase()
})

afterEach(() => {
  closeDatabase()
  closeArchiveDb()
  setHistoryConfig({ historyArchiveEnabled: true })
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("reaper move-to-tier1 dispatch", () => {
  test("enabled + attached: overflow MOVED to tier-1, not deleted", async () => {
    setHistoryConfig({ historyArchiveEnabled: true })
    attachFileArchive()
    await seed(5, "completed")
    // successLimit 2 → 3 overflow moved to archive
    const moved = runReaperOnce(2, 0)
    expect(moved).toBe(3)
    expect(queryEntryCount()).toBe(2) // HOT trimmed to limit
    expect(archiveCount()).toBe(3) // moved, NOT lost
  })

  test("disabled: falls back to legacy DELETE (no archive rows)", async () => {
    attachFileArchive()
    setHistoryConfig({ historyArchiveEnabled: false })
    await seed(5, "completed")
    const deleted = runReaperOnce(2, 0)
    expect(deleted).toBe(3)
    expect(queryEntryCount()).toBe(2)
    expect(archiveCount()).toBe(0) // legacy path destroys, nothing archived
  })

  test("enabled but archive NOT attached: safe fallback to legacy DELETE", async () => {
    setHistoryConfig({ historyArchiveEnabled: true })
    // no attachFileArchive() → isArchiveAttached false → legacy path, no throw
    await seed(4, "completed")
    const deleted = runReaperOnce(1, 0)
    expect(deleted).toBe(3)
    expect(queryEntryCount()).toBe(1)
  })

  test("runReaperTick performs periodic time-based HOT→tier-1 migration for aged rows", async () => {
    setHistoryConfig({ historyArchiveEnabled: true, historyArchiveHotDays: 3 })
    attachFileArchive()
    const now = Date.now()
    const mk = async (id: string, startedAt: number) =>
      insertCompletedEntry({
        id,
        endpoint: "anthropic-messages",
        startedAt,
        endedAt: startedAt,
        durationMs: 0,
        state: "completed",
        active: false,
        lastUpdatedAt: startedAt,
        transport: "http",
        inboundRequest: { model: "m" },
        outboundResponse: { success: true, model: "m", usage: { input_tokens: 0, output_tokens: 0 }, content: null },
      } as HistoryEntry)
    await mk("aged", now - 5 * 86400_000)
    await mk("recent", now - 1 * 86400_000)

    runReaperTick(10_000, 10_000) // limits high → no overflow eviction; only time-migration acts
    // the aged row cooled to archive; the recent one stays HOT
    expect(archiveCount()).toBe(1)
    expect((getDatabase().prepare("SELECT COUNT(*) n FROM archive.entries_v2 WHERE id = 'aged'").get() as { n: number }).n).toBe(1)
    expect(queryEntryCount()).toBe(1) // only "recent" left in HOT
  })
})
