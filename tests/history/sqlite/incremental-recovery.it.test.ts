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

import type { HistoryEntry } from "~/lib/history/types"

import {
  //
  closeDatabase,
  getDatabase,
  openDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  getEntryById,
  queryEntryCount,
} from "~/lib/history/sqlite/read"
import {
  //
  reclaimStaleActiveRows,
  runReaperOnce,
} from "~/lib/history/sqlite/reaper"
import { computeStats } from "~/lib/history/sqlite/stats"
import {
  //
  insertCompletedEntry,
  upsertHeadRow,
} from "~/lib/history/sqlite/write"

function makeEntry(overrides: Partial<HistoryEntry>): HistoryEntry {
  return {
    id: "e",
    endpoint: "anthropic-messages",
    startedAt: 1_000,
    state: "completed",
    active: false,
    lastUpdatedAt: 1_000,
    inboundRequest: { model: "m", messages: [{ role: "user", content: "hi" }] },
    ...overrides,
  } as HistoryEntry
}

describe("history incremental persistence + recovery", () => {
  beforeEach(() => {
    closeDatabase()
    openInMemoryDatabase()
  })
  afterEach(() => {
    closeDatabase()
  })

  test("eager head row (pending) is queryable before terminal, then finalize overwrites it", () => {
    const entry = makeEntry({ id: "r1", state: "pending" })
    upsertHeadRow(entry, "pending")

    const pending = getEntryById("r1")
    expect(pending?.state).toBe("pending")
    expect(pending?.inboundRequest).toBeUndefined() // no stage rows written yet

    // Finalize with full data.
    insertCompletedEntry(
      makeEntry({
        id: "r1",
        state: "completed",
        outboundResponse: { success: true, model: "m", usage: { input_tokens: 3, output_tokens: 2 }, content: { role: "assistant", content: "ok" } },
      }),
    )
    const done = getEntryById("r1")
    expect(done?.state).toBe("completed")
    expect(done?.inboundRequest.model).toBe("m")
    expect(done?.outboundResponse?.usage.input_tokens).toBe(3)
  })

  test("upsertHeadRow status update does NOT cascade-delete stage rows", () => {
    // Eager head + inbound_request stage (one transaction), then a status bump.
    const entry = makeEntry({ id: "r2", state: "pending" })
    upsertHeadRow(entry, "pending", [{ stage: "inbound_request", attemptIndex: -1, payload: entry.inboundRequest }])
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM entry_stages WHERE entry_id='r2'").get()).toEqual({ n: 1 })

    // Status transition via ON CONFLICT DO UPDATE must keep the stage row.
    upsertHeadRow(makeEntry({ id: "r2", state: "streaming" }), "streaming")
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM entry_stages WHERE entry_id='r2'").get()).toEqual({ n: 1 })
    expect(getEntryById("r2")?.state).toBe("streaming")
  })

  test("reaper: aborted/interrupted go to the failure bucket; active rows are exempt", () => {
    insertCompletedEntry(makeEntry({ id: "c1", state: "completed" }))
    insertCompletedEntry(makeEntry({ id: "f1", state: "failed" }))
    insertCompletedEntry(makeEntry({ id: "a1", state: "aborted" }))
    insertCompletedEntry(makeEntry({ id: "i1", state: "interrupted" }))
    // Active rows (never evicted, never counted in buckets).
    upsertHeadRow(makeEntry({ id: "p1", state: "pending" }), "pending")
    upsertHeadRow(makeEntry({ id: "s1", state: "streaming" }), "streaming")

    // failureLimit=1 keeps 1 of {failed, aborted, interrupted}=3 → evict 2. success bucket has 1 (≤ limit).
    const deleted = runReaperOnce(10, 1)
    expect(deleted).toBe(2)
    // Active rows survive regardless of limits.
    expect(getEntryById("p1")?.state).toBe("pending")
    expect(getEntryById("s1")?.state).toBe("streaming")
    expect(getEntryById("c1")?.state).toBe("completed")
  })

  test("deleting a head row cascades to its stage rows", () => {
    insertCompletedEntry(
      makeEntry({
        id: "casc",
        state: "completed",
        outboundResponse: { success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: null },
      }),
    )
    const db = getDatabase()
    expect((db.prepare("SELECT COUNT(*) AS n FROM entry_stages WHERE entry_id='casc'").get() as { n: number }).n).toBeGreaterThan(0)
    db.prepare("DELETE FROM entries_v2 WHERE id='casc'").run()
    expect(db.prepare("SELECT COUNT(*) AS n FROM entry_stages WHERE entry_id='casc'").get()).toEqual({ n: 0 })
  })

  test("aggregates exclude active (pending) rows: total = terminal only", () => {
    insertCompletedEntry(
      makeEntry({
        id: "t1",
        sessionId: "S",
        state: "completed",
        outboundResponse: { success: true, model: "m", usage: { input_tokens: 5, output_tokens: 1 }, content: null },
      }),
    )
    insertCompletedEntry(
      makeEntry({
        id: "t2",
        sessionId: "S",
        state: "completed",
        outboundResponse: { success: true, model: "m", usage: { input_tokens: 7, output_tokens: 1 }, content: null },
      }),
    )
    upsertHeadRow(makeEntry({ id: "t3", sessionId: "S", state: "pending" }), "pending")

    const stats = computeStats()
    expect(stats.totalRequests).toBe(2) // pending excluded
    expect(stats.successfulRequests).toBe(2)
    const session = getDatabase().prepare("SELECT request_count, total_input_tokens FROM sessions WHERE id='S'").get() as {
      request_count: number
      total_input_tokens: number
    }
    expect(session.request_count).toBe(2)
    expect(session.total_input_tokens).toBe(12)
  })

  test("stats break out aborted/interrupted distinctly; failedRequests stays = only 'failed'", () => {
    insertCompletedEntry(
      makeEntry({ id: "c", state: "completed", outboundResponse: { success: true, model: "m", usage: { input_tokens: 0, output_tokens: 0 }, content: null } }),
    )
    insertCompletedEntry(
      makeEntry({
        id: "f",
        state: "failed",
        outboundResponse: { success: false, model: "m", usage: { input_tokens: 0, output_tokens: 0 }, error: "boom", content: null },
      }),
    )
    insertCompletedEntry(makeEntry({ id: "a", state: "aborted" }))
    insertCompletedEntry(makeEntry({ id: "i1", state: "interrupted" }))
    insertCompletedEntry(makeEntry({ id: "i2", state: "interrupted" }))

    const s = computeStats()
    expect(s.successfulRequests).toBe(1)
    expect(s.failedRequests).toBe(1) // NOT inflated by aborted/interrupted
    expect(s.abortedRequests).toBe(1)
    expect(s.interruptedRequests).toBe(2)
    // total is self-consistent: sum of the four terminal categories.
    expect(s.totalRequests).toBe(s.successfulRequests + s.failedRequests + s.abortedRequests + s.interruptedRequests)
  })

  test("runtime stale reclaim flips this process's old pending rows to interrupted", () => {
    // A current-process pending row, started long ago.
    upsertHeadRow(makeEntry({ id: "stale", state: "pending", startedAt: 1, process: { pid: process.pid, bootTime: 0, version: "test" } }), "pending")
    // A fresh current-process pending row (within maxAge) must NOT be reclaimed.
    upsertHeadRow(makeEntry({ id: "fresh", state: "pending", startedAt: Date.now(), process: { pid: process.pid, bootTime: 0, version: "test" } }), "pending")

    const reclaimed = reclaimStaleActiveRows(60_000)
    expect(reclaimed).toBe(1)
    expect(getEntryById("stale")?.state).toBe("interrupted")
    expect(getEntryById("fresh")?.state).toBe("pending")
  })

  test("reclaimStaleActiveRows(0) is a no-op (disabled)", () => {
    upsertHeadRow(makeEntry({ id: "p", state: "pending", startedAt: 1, process: { pid: process.pid, bootTime: 0, version: "test" } }), "pending")
    expect(reclaimStaleActiveRows(0)).toBe(0)
    expect(getEntryById("p")?.state).toBe("pending")
  })
})

describe("history startup orphan recovery (file-backed reopen)", () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-recovery-"))
    dbPath = path.join(dir, "history.db")
  })
  afterEach(() => {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("a pending row from a prior (foreign-pid) process becomes interrupted on reopen", () => {
    openDatabase(dbPath)
    // Simulate a row left by a DEAD process: foreign pid.
    upsertHeadRow(makeEntry({ id: "orphan", state: "pending", process: { pid: 999_999, bootTime: 123, version: "old" } }), "pending")
    upsertHeadRow(makeEntry({ id: "alsofailed", state: "streaming", process: { pid: 999_999, bootTime: 123, version: "old" } }), "streaming")
    expect(queryEntryCount()).toBe(2)
    closeDatabase()

    // Reopen: startup recovery flips foreign-pid active rows → interrupted.
    openDatabase(dbPath)
    expect(getEntryById("orphan")?.state).toBe("interrupted")
    expect(getEntryById("alsofailed")?.state).toBe("interrupted")
  })
})
