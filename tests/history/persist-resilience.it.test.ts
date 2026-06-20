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
import { getEntryById } from "~/lib/history/sqlite/read"
import { STAGE } from "~/lib/history/sqlite/serialize"
import {
  //
  initHistory,
  insertEntry,
  persistEntryStages,
  shutdownHistory,
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
    inboundRequest: { model: "claude-opus-4-8" },
  } as HistoryEntry
}

describe("history persistence resilience", () => {
  beforeEach(() => {
    shutdownHistory()
    setHistoryConfig({ historyDbPath: ":memory:" })
    initHistory(true)
    openInMemoryDatabase()
  })

  afterEach(() => {
    shutdownHistory()
    closeDatabase()
    setHistoryConfig({ historyDbPath: "" })
  })

  // ── Fix C: stage persistence is head-first / FK-safe ────────────────────────
  test("persistEntryStages writes head-first when the head row is not yet persisted (no swallowed FK)", () => {
    // In-flight only — NO persistEntryEager, so there is no head row in SQLite yet.
    insertEntry(baseEntry("s1"))
    expect(getEntryById("s1")).toBeUndefined()

    // The old bare `upsertStageRow` loop hit `FOREIGN KEY constraint failed`
    // (head absent) and swallowed it → nothing persisted. The head-first write
    // upserts the head row + stages atomically, so the entry becomes queryable.
    persistEntryStages("s1", [{ stage: STAGE.sseEvents, attemptIndex: 0, payload: { events: ["x"] } }])

    expect(getEntryById("s1")).toBeDefined()
    expect(getEntryById("s1")?.state).toBe("pending")
  })
})
