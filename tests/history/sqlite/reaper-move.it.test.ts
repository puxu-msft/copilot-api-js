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

import type { HistoryEntry, RequestLifecycleState } from "~/lib/history/types"

import {
  //
  closeDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { queryEntryCount } from "~/lib/history/sqlite/read"
import { runReaperOnce, runReaperTick } from "~/lib/history/sqlite/reaper"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"

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

beforeEach(() => {
  closeDatabase()
  openInMemoryDatabase()
})

afterEach(() => {
  closeDatabase()
})

describe("terminal-record-preserving history maintenance", () => {
  test("success count limits never mutate terminal records", async () => {
    await seed(5, "completed")
    expect(runReaperOnce(2, 0)).toBe(0)
    expect(queryEntryCount()).toBe(5)
  })

  test("failure count limits never mutate terminal records", async () => {
    await seed(4, "failed")
    expect(runReaperOnce(0, 1)).toBe(0)
    expect(queryEntryCount()).toBe(4)
  })

  test("runReaperTick performs maintenance without age-based migration", async () => {
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

    runReaperTick(10_000, 10_000)
    expect(queryEntryCount()).toBe(2)
  })
})
