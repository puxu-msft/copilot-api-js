/**
 * DB-health three-piece adoption into the V3 open path (History V2 removal
 * Phase 4b) — proves the open-time maintenance (`maybeVacuumOnStartup` +
 * `seedAnalyzeIfNeeded`) and the periodic tick (`startV3Maintenance`/
 * `runV3MaintenanceTick`, wrapping `incrementalVacuum`/`checkpointWal`/
 * `runOptimize`) actually RUN against a real on-disk V3 db, not merely that
 * the functions exist unwired (see the file's own history: before Phase 4b,
 * `openDatabase`'s single V3 path returned immediately after the 5-PRAGMA
 * floor without ever calling either function — connection.ts:80-82 in the
 * pre-4b shape).
 *
 * `auto_vacuum=INCREMENTAL` is ALREADY active on every V3 db from its very
 * first open (connection.ts, unconditional, before this test's scenario
 * setup) — but merely being in INCREMENTAL mode does NOT auto-reclaim freed
 * pages; only an explicit `PRAGMA incremental_vacuum` (or a full `VACUUM`)
 * does. So a single large write followed by a single large DELETE (no
 * intervening incremental_vacuum call) leaves the freelist genuinely
 * inflated on disk — exactly the "high-freelist scenario" this test needs,
 * unaffected by auto_vacuum mode.
 */

import {
  //
  afterEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import * as connection from "~/lib/history/sqlite/connection"
import {
  //
  closeDatabase,
  openDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  isV3MaintenanceRunningForTests,
  runV3MaintenanceTick,
  startV3Maintenance,
  stopV3Maintenance,
} from "~/lib/history/v3/maintenance"
import { createDatabase } from "~/lib/sqlite/driver"

/** PRAGMA single-int helper mirroring connection.ts's private `pragmaInt`. */
function pragmaInt(db: ReturnType<typeof openDatabase>, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>
  return Number(Object.values(row)[0])
}

const tmpDirs: Array<string> = []
function freshDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-v3-db-health-"))
  tmpDirs.push(dir)
  return path.join(dir, "history-v3.db")
}

/**
 * Inflate a fresh V3 db past `maybeVacuumOnStartup`'s threshold (freelist
 * ratio ≥ 25% AND ≥ 64 MB reclaimable) using ONE big write then ONE big
 * delete — deliberately not the "many small deletes" pattern, so that
 * auto_vacuum=INCREMENTAL (already active) has no opportunity to reclaim
 * anything without an explicit incremental_vacuum call in between.
 */
function bloatPastVacuumThreshold(dbPath: string): void {
  const db = openDatabase(dbPath)
  const blob = new Uint8Array(64 * 1024).fill(0x41) // 64 KB per row
  db.exec("CREATE TABLE IF NOT EXISTS v3_objects (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, canonical_gz BLOB NOT NULL, canonical_bytes INTEGER NOT NULL)")
  const insert = db.prepare("INSERT INTO v3_objects (hash, kind, canonical_gz, canonical_bytes) VALUES (?, 'payload', ?, ?)")
  // 64 KB * 1100 rows ≈ 68 MB — clears both the 64 MB floor and the 25% freelist ratio once deleted.
  const tx = db.transaction(() => {
    for (let i = 0; i < 1100; i++) insert.run(`bloat-${i}`, blob, blob.byteLength)
  })
  tx()
  db.exec("DELETE FROM v3_objects") // single large delete — no interleaved incremental_vacuum
  closeDatabase()
}

afterEach(() => {
  closeDatabase()
  stopV3Maintenance()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("DB-health adopted into the V3 open path (Phase 4b)", () => {
  test("maybeVacuumOnStartup fires on reopen: high freelist ratio drops after VACUUM", () => {
    const dbPath = freshDbPath()
    bloatPastVacuumThreshold(dbPath)

    // Sanity: the bloat actually inflated the freelist BEFORE the health-check
    // reopen — otherwise this test would trivially pass regardless of whether
    // maybeVacuumOnStartup is wired (empirical-verification: prove the negative
    // baseline, not just the positive assertion). Inspect via a RAW driver
    // connection (bypassing openDatabase entirely) — an openDatabase() call
    // here would itself already run the health check under test and mask the
    // pre-fix freelist state.
    const rawDb = createDatabase(dbPath)
    const freelistBeforeHealthReopen = pragmaInt(rawDb, "freelist_count")
    expect(freelistBeforeHealthReopen).toBeGreaterThan(0)
    rawDb.close()

    // The reopen under test — openDatabase's own internal call to
    // maybeVacuumOnStartup (wired in Phase 4b) must fire here.
    const db = openDatabase(dbPath)
    expect(pragmaInt(db, "freelist_count")).toBe(0)
  })

  test("seedAnalyzeIfNeeded fires on first open: sqlite_stat1 exists", () => {
    const dbPath = freshDbPath()
    const db = openDatabase(dbPath)
    // `.get()` returns `null` (bun:sqlite) / `undefined` (node:sqlite) when no
    // row matches — `toBeDefined()` alone would NOT catch `null`, so assert
    // truthiness directly (empirical-verification: this exact mistake was
    // caught by first proving RED against the un-wired connection.ts, where
    // `.get()` correctly returned `null` and a `toBeDefined()`-only assertion
    // would have silently passed).
    const stat1 = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_stat1'").get()
    expect(stat1).toBeTruthy()
  })

  test("startV3Maintenance arms the timer; runV3MaintenanceTick invokes checkpointWal + incrementalVacuum + runOptimize", () => {
    openDatabase(freshDbPath())

    const checkpointSpy = spyOn(connection, "checkpointWal")
    const vacuumSpy = spyOn(connection, "incrementalVacuum")
    const optimizeSpy = spyOn(connection, "runOptimize")

    expect(isV3MaintenanceRunningForTests()).toBe(false)
    startV3Maintenance(connection.getDatabase(), 3600) // long interval — this test drives the tick directly, not via the timer
    expect(isV3MaintenanceRunningForTests()).toBe(true)

    runV3MaintenanceTick(connection.getDatabase())

    expect(checkpointSpy).toHaveBeenCalledTimes(1)
    expect(vacuumSpy).toHaveBeenCalledTimes(1)
    expect(optimizeSpy).toHaveBeenCalledTimes(1)

    stopV3Maintenance()
    expect(isV3MaintenanceRunningForTests()).toBe(false)
  })
})
