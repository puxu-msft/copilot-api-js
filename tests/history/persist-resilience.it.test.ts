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
import {
  //
  runReaperTick,
  startReaper,
  stopReaper,
} from "~/lib/history/sqlite/reaper"
import { STAGE } from "~/lib/history/sqlite/serialize"
import { upsertHeadRow } from "~/lib/history/sqlite/write"
import {
  //
  __setTerminalWriterForTests,
  drainPendingFinalizations,
  finalizeEntry,
  getInFlightEntry,
  initHistory,
  insertEntry,
  persistEntryStages,
  retryPendingFinalizations,
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
    model: { requested: "claude-opus-4-8" },
    clientRequest: { format: "anthropic-messages", model: "claude-opus-4-8" },
  } as HistoryEntry
}

function markFailed(id: string): void {
  updateEntry(id, {
    state: "failed",
    active: false,
    lastUpdatedAt: Date.now(),
    endedAt: Date.now(),
    attempts: [
      {
        index: 0,
        durationMs: 0,
        error: "Stream closed with error code NGHTTP2_CANCEL",
        upstreamResponse: {
          success: false,
          model: "claude-opus-4-8",
          usage: { input_tokens: 7, output_tokens: 0 },
          body: null,
        },
      },
    ],
    _index: { derived: { responseSuccess: false, failureReason: "Stream closed with error code NGHTTP2_CANCEL", attemptCount: 1 } },
  })
}

function sqliteError(message: string, code?: string): Error {
  const err = new Error(message)
  if (code) (err as { code?: string }).code = code
  return err
}

describe("history persistence resilience", () => {
  beforeEach(async () => {
    await shutdownHistory()
    setHistoryConfig({ historyDbPath: ":memory:" })
    initHistory(true)
    openInMemoryDatabase()
    startReaper(100, 100, 60)
  })

  afterEach(async () => {
    __setTerminalWriterForTests(undefined)
    await shutdownHistory()
    closeDatabase()
    setHistoryConfig({ historyDbPath: "" })
  })

  // ── Fix C: stage persistence is head-first / FK-safe ────────────────────────
  test("persistEntryStages writes head-first when the head row is not yet persisted (no swallowed FK)", async () => {
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

  // ── Fix B: finalize is non-lossy ────────────────────────────────────────────
  test("finalize retains the in-flight entry on a TRANSIENT write error, then a reaper drain persists it", async () => {
    insertEntry(baseEntry("t1"))
    markFailed("t1")

    // Terminal write fails transiently (SQLITE_BUSY under WAL contention).
    __setTerminalWriterForTests(() => {
      throw sqliteError("database is locked", "SQLITE_BUSY")
    })
    await finalizeEntry("t1")

    // NOT dropped: retained in-flight, nothing written, no silent loss.
    expect(getInFlightEntry("t1")).toBeDefined()
    expect(getEntryById("t1")).toBeUndefined()

    // Contention clears → reaper-tick drain re-attempts and the entry persists.
    __setTerminalWriterForTests(undefined)
    await retryPendingFinalizations()
    expect(getInFlightEntry("t1")).toBeUndefined()
    expect(getEntryById("t1")?.state).toBe("failed")
  })

  test("finalize degrades to a tombstone on a PERMANENT write error (the FACT survives, never silently lost)", async () => {
    insertEntry(baseEntry("p1"))
    markFailed("p1")

    // Terminal (full) write fails permanently (e.g. oversized blob) — retrying
    // is pointless, so the entry degrades to a tombstone (head + the small
    // inbound_request/outbound_response stages, skipping the bulk).
    __setTerminalWriterForTests(() => {
      throw sqliteError("string or blob too big", "SQLITE_TOOBIG")
    })
    await finalizeEntry("p1")
    __setTerminalWriterForTests(undefined)

    // In-flight dropped (bounded memory), but the tombstone is READABLE and
    // preserves the FACT: status + model + error all survive for diagnosis.
    expect(getInFlightEntry("p1")).toBeUndefined()
    const row = getEntryById("p1")
    expect(row).toBeDefined()
    expect(row?.state).toBe("failed")
    // Regression guard (review CRITICAL): a head-only tombstone left
    // clientRequest undefined and crashed detail/export consumers. The tombstone
    // now writes the client_request + upstream_response stages, so they read back.
    expect(row?.clientRequest?.model).toBe("claude-opus-4-8")
    expect(row?._index?.derived?.failureReason).toContain("NGHTTP2_CANCEL")
  })

  test("with the reaper disabled/stopped, a transient failure tombstones immediately (no in-flight leak)", async () => {
    insertEntry(baseEntry("d1"))
    markFailed("d1")
    stopReaper() // no drain will ever come → retaining would leak forever

    __setTerminalWriterForTests(() => {
      throw sqliteError("database is locked", "SQLITE_BUSY")
    })
    await finalizeEntry("d1")
    __setTerminalWriterForTests(undefined)

    // Must NOT be retained in-flight (would leak); degrades straight to tombstone.
    expect(getInFlightEntry("d1")).toBeUndefined()
    expect(getEntryById("d1")?.state).toBe("failed")
  })

  test("a head-only row (no stage rows) reads back without crashing — clientRequest absent, model preserved", async () => {
    // Simulate the worst case: even the tombstone stage write failed, leaving a
    // head-only row. Per the new-model design (see sqlite/incremental-recovery),
    // the heavy `clientRequest` leg lives in the not-yet-written client_request
    // stage, so it is ABSENT on the assembled entry — partiality is governed by
    // `state`, not field presence. Consumers must read it defensively (optional
    // chaining) so a partial row never crashes the detail view / CSV export.
    const entry = baseEntry("h1")
    entry.state = "failed"
    upsertHeadRow(entry, "failed") // head only, NO stages

    const row = getEntryById("h1")
    expect(row).toBeDefined()
    // The request model FACT survives via the `model{}` head-meta (also mirrored
    // into the head `model` column → summaries), even though the clientRequest leg
    // is absent.
    expect(row?.model?.requested).toBe("claude-opus-4-8")
    expect(row?.clientRequest).toBeUndefined()
    // The historical crash was `entry.inboundRequest.messages` on undefined; the
    // new-model consumers optional-chain `clientRequest?.messages`, so it can't throw.
    expect(() => row?.clientRequest?.messages?.length).not.toThrow()
  })

  test("finalize succeeds normally when the write works (baseline — entry persisted + removed from in-flight)", async () => {
    insertEntry(baseEntry("ok1"))
    markFailed("ok1")
    await finalizeEntry("ok1")
    expect(getInFlightEntry("ok1")).toBeUndefined()
    expect(getEntryById("ok1")?.state).toBe("failed")
  })

  // ── Fix D: the reaper tick drains deferred finalizations (hook wiring) ───────
  test("a reaper tick drains a transiently-deferred finalize via the registered hook", async () => {
    insertEntry(baseEntry("r1"))
    markFailed("r1")

    // Transiently fail → entry retained in-flight, pending a retry.
    __setTerminalWriterForTests(() => {
      throw sqliteError("database is locked", "SQLITE_BUSY")
    })
    await finalizeEntry("r1")
    expect(getInFlightEntry("r1")).toBeDefined()

    // The writer recovers; one reaper tick runs the auto-registered drain hook
    // (retryPendingFinalizations) + a WAL checkpoint, persisting the entry. The
    // hook is fire-and-forget (async finalize), so drain the kicked finalize.
    __setTerminalWriterForTests(undefined)
    runReaperTick(100, 200)
    await drainPendingFinalizations()
    expect(getInFlightEntry("r1")).toBeUndefined()
    expect(getEntryById("r1")?.state).toBe("failed")
  })
})
