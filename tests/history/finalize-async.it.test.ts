/**
 * P2 invariant tests for the finalize async-offload refactor
 * (docs/rfc/history-finalize-async-offload.md §4 I2 / I4).
 *
 * The async-offload behaviors that did NOT exist before:
 *   - I2 re-entrancy: a finalize now spans `await`s, so a duplicate
 *     `finalizeEntry(id)` (reaper retry tick / double terminal event) must be a
 *     no-op rather than a double write / double removeInFlight.
 *   - I4 shutdown drain: a fire-and-forget finalize in flight at shutdown must be
 *     awaited BEFORE the DB closes — otherwise it writes a dead handle and is lost.
 *
 * I1 (lossless on transient/permanent) is covered by persist-resilience.it; the
 * byte-equivalence of the offloaded output is locked by sqlite/finalize-async-golden.
 */
import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import { getHistoryPersistErrorStats } from "~/lib/history/persist-guard"
import { getEntryById } from "~/lib/history/sqlite/read"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"
import {
  //
  __setTerminalWriterForTests,
  drainPendingFinalizations,
  finalizeEntry,
  getInFlightEntry,
  insertEntry,
  shutdownHistory,
  updateEntry,
} from "~/lib/history/store"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function seedTerminal(id: string): void {
  insertEntry({
    id,
    sessionId: "s",
    startedAt: Date.now(),
    endpoint: "anthropic-messages",
    inboundRequest: { model: "claude-opus-4", messages: [{ role: "user", content: `body ${id}` }] },
  } as HistoryEntry)
  updateEntry(id, {
    state: "completed",
    outboundResponse: { success: true, model: "claude-opus-4", usage: { input_tokens: 1, output_tokens: 1 }, content: { role: "assistant", content: "ok" } },
  })
}

describe("finalize async-offload — P2 invariants", () => {
  useIsolatedRuntime()

  test("offloaded finalize persists the entry and removes it from in-flight (baseline)", async () => {
    seedTerminal("a1")
    await finalizeEntry("a1")
    expect(getInFlightEntry("a1")).toBeUndefined()
    expect(getEntryById("a1")?.state).toBe("completed")
  })

  test("I2: a duplicate finalize mid-flight is a no-op (single write, no double removeInFlight)", async () => {
    seedTerminal("r1")
    let writes = 0
    __setTerminalWriterForTests(async (entry) => {
      writes++
      await sleep(10) // hold the async window open so the second call overlaps
      await insertCompletedEntry(entry)
    })

    const first = finalizeEntry("r1") // enters, marks `finalizing`, awaits the slow write
    const second = finalizeEntry("r1") // sees `finalizing` → no-op
    await Promise.all([first, second])

    expect(writes).toBe(1) // the re-entrancy guard suppressed the second write
    expect(getInFlightEntry("r1")).toBeUndefined()
    expect(getEntryById("r1")?.state).toBe("completed")
    __setTerminalWriterForTests(undefined)
  })

  test("I2: after a finalize settles, the id can be finalized again (guard released, not sticky)", async () => {
    seedTerminal("r2")
    await finalizeEntry("r2")
    // Re-insert + finalize the same id again — the guard must have been released.
    seedTerminal("r2")
    await finalizeEntry("r2")
    expect(getEntryById("r2")?.state).toBe("completed")
  })

  test("I4: shutdownHistory drains an in-flight fire-and-forget finalize before closing the DB", async () => {
    seedTerminal("d1")
    // Fire-and-forget (the production sink path): do NOT await the finalize.
    void finalizeEntry("d1")
    // shutdownHistory must await the pending finalize BEFORE closeDatabase — if it
    // closed first, the finalize would hit a dead handle and log a permanent error.
    await shutdownHistory()
    // No "Cannot use a closed database" permanent failure was recorded.
    expect(getHistoryPersistErrorStats()["finalize:permanent"]).toBeUndefined()
  })

  test("I4: drainPendingFinalizations awaits all in-flight finalizes", async () => {
    seedTerminal("d2")
    seedTerminal("d3")
    void finalizeEntry("d2")
    void finalizeEntry("d3")
    await drainPendingFinalizations()
    expect(getInFlightEntry("d2")).toBeUndefined()
    expect(getInFlightEntry("d3")).toBeUndefined()
    expect(getEntryById("d2")?.state).toBe("completed")
    expect(getEntryById("d3")?.state).toBe("completed")
  })
})
