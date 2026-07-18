/**
 * Positive regression test for the History V2 removal C3 fix (plan §2 C3 /
 * §3 Phase 4a): before Phase 4a, `openDatabase(":memory:")` never matched the
 * `v3Only` basename check (`path.basename(dbPath) === "history-v3.db"`), so an
 * in-memory DB fell through to the V2 schema branch and built `entries_v2` +
 * friends even though every production/test caller intends V3-only semantics.
 *
 * After 4a's collapse to a single unconditional path, `entries_v2` (and the
 * other V2-only tables) must never be created for ANY dbPath, `:memory:`
 * included — this is the direct positive proof of that fix, not just an
 * absence-of-error observation.
 */

import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"

import {
  //
  closeDatabase,
  openDatabase,
} from "~/lib/history/sqlite/connection"

afterEach(() => {
  closeDatabase()
})

test("openDatabase(':memory:') never creates entries_v2 (or other V2-only tables)", () => {
  const db = openDatabase(":memory:")

  const entriesV2 = db.prepare("PRAGMA table_info(entries_v2)").all()
  expect(entriesV2).toEqual([])

  const entryStages = db.prepare("PRAGMA table_info(entry_stages)").all()
  expect(entryStages).toEqual([])

  const responseSessions = db.prepare("PRAGMA table_info(response_sessions)").all()
  expect(responseSessions).toEqual([])

  // Sanity: the identity marker (always written, V3 or V2) proves the DB was
  // actually opened+reconciled, not just an empty untouched handle.
  const identity = db.prepare("SELECT owner FROM history_store_identity LIMIT 1").get() as { owner: string } | undefined
  expect(identity?.owner).toBe("copilot-api-history-v3")
})
