import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history"

import {
  //
  closeDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  getEntryById,
  queryEntryCount,
} from "~/lib/history/sqlite/read"
import {
  //
  finalizeEntry,
  getEntry,
  initHistory,
  insertEntry,
  shutdownHistory,
  updateEntry,
} from "~/lib/history/store"
import { setHistoryConfig } from "~/lib/state"

function baseEntry(id: string): HistoryEntry {
  return {
    id,
    endpoint: "anthropic-messages",
    startedAt: Date.now(),
    state: "pending",
    active: true,
    lastUpdatedAt: Date.now(),
    model: { requested: "claude-opus-4-7" },
    clientRequest: { format: "anthropic-messages", model: "claude-opus-4-7" },
  } as HistoryEntry
}

describe("history persistence boundary", () => {
  beforeEach(async () => {
    // Ensure any previous db is closed, then force initHistory to use in-memory
    await shutdownHistory()
    setHistoryConfig({ historyDbPath: ":memory:" })
    initHistory(true)
    // Guard: openInMemoryDatabase is idempotent if already in-memory
    openInMemoryDatabase()
  })

  afterEach(async () => {
    await shutdownHistory()
    closeDatabase()
    setHistoryConfig({ historyDbPath: "" })
  })

  test("pending entry stays out of sqlite", async () => {
    insertEntry(baseEntry("e1"))
    expect(queryEntryCount()).toBe(0)
    expect(getEntry("e1")?.state).toBe("pending")
    expect(getEntryById("e1")).toBeUndefined()
  })

  test("only writes to sqlite on completion", async () => {
    insertEntry(baseEntry("e2"))
    updateEntry("e2", { state: "streaming", active: true, lastUpdatedAt: Date.now() })
    expect(queryEntryCount()).toBe(0)

    updateEntry("e2", {
      state: "completed",
      active: false,
      lastUpdatedAt: Date.now(),
      endedAt: Date.now(),
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "claude-opus-4-7",
            usage: { input_tokens: 1, output_tokens: 1 },
            body: null,
          },
        },
      ],
      _index: { derived: { responseSuccess: true, attemptCount: 1 } },
    })
    // updateEntry no longer auto-persists; finalizeEntry is the explicit step
    // (see entries.ts docstring). State alone is not a side-effect trigger.
    expect(queryEntryCount()).toBe(0)
    await finalizeEntry("e2")
    expect(queryEntryCount()).toBe(1)
    // After finalize the entry lives in SQLite (not in-flight) — getEntry
    // reads SQLite as fallback, so we still see "completed" via that path.
    expect(getEntry("e2")?.state).toBe("completed")
    expect(getEntryById("e2")).toBeDefined()
    expect(getEntryById("e2")?.state).toBe("completed")
  })

  test("failed entries are also persisted", async () => {
    insertEntry(baseEntry("e3"))
    updateEntry("e3", {
      state: "failed",
      active: false,
      lastUpdatedAt: Date.now(),
      endedAt: Date.now(),
      attempts: [
        {
          index: 0,
          durationMs: 0,
          error: "timeout",
          upstreamResponse: {
            success: false,
            model: "claude-opus-4-7",
            usage: { input_tokens: 0, output_tokens: 0 },
            body: null,
          },
        },
      ],
      _index: { derived: { responseSuccess: false, failureReason: "timeout", attemptCount: 1 } },
    })
    await finalizeEntry("e3")
    expect(queryEntryCount()).toBe(1)
    expect(getEntryById("e3")).toBeDefined()
  })

  test("client timing survives updateEntry allowlist → finalize → 3 columns round-trip (spec 2026-07-14)", async () => {
    insertEntry(baseEntry("e-timing"))
    // updateEntry with `timing` proves the Pick<> allowlist accepts it (plan review M-B).
    updateEntry("e-timing", {
      state: "completed",
      active: false,
      lastUpdatedAt: Date.now(),
      endedAt: Date.now(),
      timing: { client: { streamOpenMs: 20, firstRealMs: 79000, bufferHoldStartMs: 20 } },
    })
    await finalizeEntry("e-timing")

    // Read back through the full SELECT * → deserializeEntry → column reconstruction.
    const restored = getEntryById("e-timing")
    expect(restored?.timing?.client).toEqual({ streamOpenMs: 20, firstRealMs: 79000, bufferHoldStartMs: 20 })
  })

  test("timing absent → columns NULL → timing undefined on read", async () => {
    insertEntry(baseEntry("e-no-timing"))
    updateEntry("e-no-timing", { state: "completed", active: false, lastUpdatedAt: Date.now(), endedAt: Date.now() })
    await finalizeEntry("e-no-timing")
    expect(getEntryById("e-no-timing")?.timing).toBeUndefined()
  })
})
