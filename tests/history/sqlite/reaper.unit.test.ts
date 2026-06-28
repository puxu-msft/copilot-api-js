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
import {
  //
  getEntryById,
  queryEntryCount,
  querySummaries,
} from "~/lib/history/sqlite/read"
import {
  //
  reclaimStaleActiveRows,
  runReaperOnce,
} from "~/lib/history/sqlite/reaper"
import {
  //
  insertCompletedEntry,
  setEntryPinned,
} from "~/lib/history/sqlite/write"
import { getProcessIdentity } from "~/lib/process-identity"

/** Seed `n` entries with the given lifecycle state, ids prefixed by state. */
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

describe("reaper (per-status buckets)", () => {
  beforeEach(async () => {
    closeDatabase()
    openInMemoryDatabase()
  })

  test("no-op when each bucket within its limit", async () => {
    await seed(5, "completed")
    await seed(5, "failed", 2_000)
    expect(runReaperOnce(10, 10)).toBe(0)
    expect(queryEntryCount()).toBe(10)
  })

  test("success overflow only evicts oldest successes", async () => {
    await seed(8, "completed")
    await seed(3, "failed", 2_000)
    const deleted = runReaperOnce(5, 10)
    expect(deleted).toBe(3)
    expect(queryEntryCount({ success: true })).toBe(5)
    expect(queryEntryCount({ success: false })).toBe(3)
  })

  test("failure overflow only evicts oldest failures", async () => {
    await seed(3, "completed")
    await seed(8, "failed", 2_000)
    const deleted = runReaperOnce(10, 5)
    expect(deleted).toBe(3)
    expect(queryEntryCount({ success: false })).toBe(5)
    expect(queryEntryCount({ success: true })).toBe(3)
  })

  test("one bucket full does not affect the other", async () => {
    await seed(10, "completed")
    await seed(2, "failed", 2_000)
    runReaperOnce(4, 4)
    expect(queryEntryCount({ success: true })).toBe(4)
    expect(queryEntryCount({ success: false })).toBe(2)
  })

  test("successLimit=0 disables success eviction", async () => {
    await seed(6, "completed")
    await seed(6, "failed", 2_000)
    const deleted = runReaperOnce(0, 4)
    expect(deleted).toBe(2)
    expect(queryEntryCount({ success: true })).toBe(6)
    expect(queryEntryCount({ success: false })).toBe(4)
  })

  test("failureLimit=0 disables failure eviction", async () => {
    await seed(6, "completed")
    await seed(6, "failed", 2_000)
    const deleted = runReaperOnce(4, 0)
    expect(deleted).toBe(2)
    expect(queryEntryCount({ success: false })).toBe(6)
    expect(queryEntryCount({ success: true })).toBe(4)
  })

  test("both limits 0 is a total no-op", async () => {
    await seed(3, "completed")
    await seed(3, "failed", 2_000)
    expect(runReaperOnce(0, 0)).toBe(0)
    expect(queryEntryCount()).toBe(6)
  })

  test("FIFO by startedAt within the success bucket", async () => {
    await seed(5, "completed", 1_000) // completed-0..4 with ts 1000..1004
    runReaperOnce(2, 10)
    // Oldest three removed, newest two kept.
    expect(queryEntryCount({ success: true })).toBe(2)
  })

  test("a pinned row is exempt from eviction AND from bucket counting", async () => {
    await seed(5, "completed", 1_000) // completed-0..4, ts 1000..1004
    expect(setEntryPinned("completed-0", true)).toBe(true) // pin the OLDEST
    // Bucket now = unpinned completed-1..4 (4 rows). limit 2 → evict oldest 2
    // (completed-1, completed-2); keep completed-3, completed-4. Pinned
    // completed-0 is outside the bucket entirely, so it neither counts nor dies.
    const deleted = runReaperOnce(2, 10)
    expect(deleted).toBe(2)
    expect(queryEntryCount()).toBe(3) // completed-0 (pinned) + completed-3,4
    expect(getEntryById("completed-0")).toBeDefined() // pinned survived as oldest
    expect(getEntryById("completed-1")).toBeUndefined()
    expect(getEntryById("completed-2")).toBeUndefined()
  })

  test("pinning every overflowing row prevents all eviction", async () => {
    await seed(5, "completed", 1_000)
    for (let i = 0; i < 5; i++) expect(setEntryPinned(`completed-${i}`, true)).toBe(true)
    expect(runReaperOnce(2, 10)).toBe(0) // bucket is empty after exclusion
    expect(queryEntryCount()).toBe(5)
  })

  test("a failed pinned row is exempt from the failure bucket too", async () => {
    await seed(5, "failed", 2_000)
    expect(setEntryPinned("failed-0", true)).toBe(true)
    const deleted = runReaperOnce(10, 2)
    expect(deleted).toBe(2) // unpinned failed-1..4 over limit 2 → evict 2 oldest
    expect(getEntryById("failed-0")).toBeDefined()
    expect(queryEntryCount()).toBe(3)
  })

  test("unpinning restores reaper eligibility", async () => {
    await seed(5, "completed", 1_000)
    expect(setEntryPinned("completed-0", true)).toBe(true)
    expect(setEntryPinned("completed-0", false)).toBe(true) // back to normal
    // All 5 unpinned again: limit 2 → evict oldest 3 incl. completed-0.
    runReaperOnce(2, 10)
    expect(getEntryById("completed-0")).toBeUndefined()
    expect(queryEntryCount({ success: true })).toBe(2)
  })

  test("setEntryPinned on an unknown id returns false", async () => {
    expect(setEntryPinned("nope", true)).toBe(false)
  })
})

describe("reclaimStaleActiveRows — interrupted reclassification (MEDIUM-2)", () => {
  beforeEach(async () => {
    closeDatabase()
    openInMemoryDatabase()
  })

  test("reclaims a stale active row → interrupted AND backfills a failure reason for the list view", async () => {
    const { pid } = getProcessIdentity()
    // An active (executing) row from THIS pid, started long ago, with no response leg.
    await insertCompletedEntry({
      id: "stuck-0",
      endpoint: "anthropic-messages",
      startedAt: 1_000, // far older than any sane cutoff
      durationMs: 0,
      state: "executing",
      active: true,
      lastUpdatedAt: 1_000,
      transport: "http",
      process: { pid },
      inboundRequest: { model: "m" },
    } as HistoryEntry)

    const reclaimed = reclaimStaleActiveRows(1) // maxAge 1ms → cutoff ≈ now-1, so started_at 1000 qualifies
    expect(reclaimed).toBe(1)

    const summary = querySummaries().find((s) => s.id === "stuck-0")
    expect(summary?.state).toBe("interrupted")
    // The list view now shows WHY (richest-data-flow), not a null reason.
    expect(summary?.responseError).toContain("maximum age")
  })
})
