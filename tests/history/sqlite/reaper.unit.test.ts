import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import {
  //
  closeDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { queryEntryCount } from "~/lib/history/sqlite/read"
import { runReaperOnce } from "~/lib/history/sqlite/reaper"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"

function seed(n: number): void {
  for (let i = 0; i < n; i++) {
    insertCompletedEntry({
      id: `e${i}`,
      endpoint: "anthropic-messages",
      startedAt: 1_000 + i,
      endedAt: 1_000 + i,
      durationMs: 0,
      state: "completed",
      active: false,
      lastUpdatedAt: 1_000 + i,
      transport: "http",
      inboundRequest: { model: "m" },
      outboundResponse: { success: true, model: "m", usage: { input_tokens: 0, output_tokens: 0 }, content: null },
    } as HistoryEntry)
  }
}

describe("reaper", () => {
  beforeEach(() => {
    closeDatabase()
    openInMemoryDatabase()
  })

  test("no-op when count <= limit", () => {
    seed(5)
    expect(runReaperOnce(10)).toBe(0)
    expect(queryEntryCount()).toBe(5)
  })

  test("deletes oldest beyond limit", () => {
    seed(8)
    const deleted = runReaperOnce(5)
    expect(deleted).toBe(3)
    expect(queryEntryCount()).toBe(5)
  })

  test("limit=0 disables eviction", () => {
    seed(3)
    expect(runReaperOnce(0)).toBe(0)
    expect(queryEntryCount()).toBe(3)
  })
})
