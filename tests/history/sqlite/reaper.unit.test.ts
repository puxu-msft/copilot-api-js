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
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { queryEntryCount } from "~/lib/history/sqlite/read"
import { runReaperOnce } from "~/lib/history/sqlite/reaper"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"

/** Seed `n` entries with the given lifecycle state, ids prefixed by state. */
function seed(n: number, status: RequestLifecycleState = "completed", startBase = 1_000): void {
  for (let i = 0; i < n; i++) {
    const ts = startBase + i
    insertCompletedEntry({
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

describe("reaper (per-status buckets)", () => {
  beforeEach(() => {
    closeDatabase()
    openInMemoryDatabase()
  })

  test("no-op when each bucket within its limit", () => {
    seed(5, "completed")
    seed(5, "failed", 2_000)
    expect(runReaperOnce(10, 10)).toBe(0)
    expect(queryEntryCount()).toBe(10)
  })

  test("success overflow only evicts oldest successes", () => {
    seed(8, "completed")
    seed(3, "failed", 2_000)
    const deleted = runReaperOnce(5, 10)
    expect(deleted).toBe(3)
    expect(queryEntryCount({ success: true })).toBe(5)
    expect(queryEntryCount({ success: false })).toBe(3)
  })

  test("failure overflow only evicts oldest failures", () => {
    seed(3, "completed")
    seed(8, "failed", 2_000)
    const deleted = runReaperOnce(10, 5)
    expect(deleted).toBe(3)
    expect(queryEntryCount({ success: false })).toBe(5)
    expect(queryEntryCount({ success: true })).toBe(3)
  })

  test("one bucket full does not affect the other", () => {
    seed(10, "completed")
    seed(2, "failed", 2_000)
    runReaperOnce(4, 4)
    expect(queryEntryCount({ success: true })).toBe(4)
    expect(queryEntryCount({ success: false })).toBe(2)
  })

  test("successLimit=0 disables success eviction", () => {
    seed(6, "completed")
    seed(6, "failed", 2_000)
    const deleted = runReaperOnce(0, 4)
    expect(deleted).toBe(2)
    expect(queryEntryCount({ success: true })).toBe(6)
    expect(queryEntryCount({ success: false })).toBe(4)
  })

  test("failureLimit=0 disables failure eviction", () => {
    seed(6, "completed")
    seed(6, "failed", 2_000)
    const deleted = runReaperOnce(4, 0)
    expect(deleted).toBe(2)
    expect(queryEntryCount({ success: false })).toBe(6)
    expect(queryEntryCount({ success: true })).toBe(4)
  })

  test("both limits 0 is a total no-op", () => {
    seed(3, "completed")
    seed(3, "failed", 2_000)
    expect(runReaperOnce(0, 0)).toBe(0)
    expect(queryEntryCount()).toBe(6)
  })

  test("FIFO by startedAt within the success bucket", () => {
    seed(5, "completed", 1_000) // completed-0..4 with ts 1000..1004
    runReaperOnce(2, 10)
    // Oldest three removed, newest two kept.
    expect(queryEntryCount({ success: true })).toBe(2)
  })
})
