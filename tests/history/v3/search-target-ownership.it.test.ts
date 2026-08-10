/**
 * The frozen search target and the "which overlay rows does the index already own?" answer are only
 * meaningful together: the sidecar counts what is inside the target, and the overlay contributes
 * what is outside it. Read from two different snapshots they can disagree, and a row landing in
 * between belongs to neither — the sidecar has not seen it, and the overlay has already disowned it.
 *
 * This drives that window directly rather than waiting to observe it: a real second connection
 * commits DURING the freeze, at the one instant that matters, and the assertion is that the answer
 * does not move. WAL is what makes it a fair test — readers do not block writers, so the concurrent
 * commit genuinely lands mid-freeze rather than queueing behind it.
 */
import { Database as BunDatabase } from "bun:sqlite"
import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Database } from "~/lib/history/sqlite/connection"
import type { SqliteStatement } from "~/lib/sqlite/driver"

import {
  //
  closeDatabase,
  getDatabase,
  openDatabase,
} from "~/lib/history/sqlite/connection"
import { applyForwardMigrations } from "~/lib/history/sqlite/migrations/run"
import {
  //
  ensureV3Schema,
  validateAndMarkSummaryProjectionReady,
} from "~/lib/history/v3/store"
import { freezeHistorySearchOwnership } from "~/lib/history/v3/summary-store"

import { commitV3HistoryEntry } from "../../helpers/history-v3-fixtures"

const tmpDirs: Array<string> = []
function freshDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  closeDatabase()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * A database view that runs `onTargetRead` immediately after the target's `MAX(committed_at)` query
 * returns — i.e. inside the freeze, after the snapshot would have been taken.
 */
function withCommitDuringFreeze(database: Database, onTargetRead: () => void): Database {
  let fired = false
  const wrapStatement = (sql: string, statement: SqliteStatement): SqliteStatement => {
    if (!sql.includes("MAX(committed_at)")) return statement
    return new Proxy(statement, {
      get(target, property) {
        if (property === "get") {
          return (...args: Array<unknown>) => {
            const row = (target.get as (...inner: Array<unknown>) => unknown)(...args)
            if (!fired) {
              fired = true
              onTargetRead()
            }
            return row
          }
        }
        const value = Reflect.get(target, property) as unknown
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  }
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrapStatement(sql, target.prepare(sql))
      const value = Reflect.get(target, property) as unknown
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

describe("history search target ownership", () => {
  test("does not disown an overlay row on the strength of a write that landed after the snapshot", async () => {
    const dbPath = path.join(freshDir("search-ownership-db-"), "history-v3.db")
    openDatabase(dbPath)
    ensureV3Schema(getDatabase())
    await applyForwardMigrations(getDatabase())

    commitV3HistoryEntry({
      id: "race-row",
      operationKind: "generation",
      startedAt: 100,
      endedAt: 110,
      endpoint: "anthropic-messages",
      state: "completed",
      process: { pid: 10, bootTime: 1, version: "test" },
      clientRequest: { model: "m", messages: [{ role: "user", content: "race" }] },
      clientResponse: { status: 200 },
      attempts: [],
      model: {},
    })
    expect(validateAndMarkSummaryProjectionReady(getDatabase()).ready).toBe(true)

    // Start from "the index cannot serve this row yet", so that becoming servable is a write with a
    // definite moment — the moment this test places inside the freeze.
    getDatabase().prepare("UPDATE v3_operation_summaries SET projection_status='pending' WHERE operation_id=?").run("race-row")

    const concurrent = new BunDatabase(dbPath)
    let committedDuringFreeze = false
    try {
      const view = withCommitDuringFreeze(getDatabase(), () => {
        concurrent.run("UPDATE v3_operation_summaries SET projection_status='ready' WHERE operation_id=?", ["race-row"])
        committedDuringFreeze = true
      })

      const { target, indexOwned } = freezeHistorySearchOwnership(view, ["race-row"], { operationKind: "generation" })

      // The injection is a precondition, not a result: without it this asserts nothing.
      expect(committedDuringFreeze).toBe(true)
      expect(target).not.toBeNull()
      // The row became servable AFTER the snapshot, so this freeze must still report it as the
      // overlay's. Reading ownership outside the snapshot would hand it to an index whose frozen
      // target does not contain it, and the row would appear in neither half of the page.
      expect(indexOwned.has("race-row")).toBe(false)
    } finally {
      concurrent.close()
    }

    // The next freeze, taken cleanly after that write, does see it — otherwise the assertion above
    // would also hold for an ownership probe that never works at all.
    expect(freezeHistorySearchOwnership(getDatabase(), ["race-row"], { operationKind: "generation" }).indexOwned.has("race-row")).toBe(true)
  })
})
