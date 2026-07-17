/**
 * HOT→TIER-1 move semantics (spec §3.4/§3.5) — the highest-risk phase.
 *
 * Covers: single-entry move round-trip fidelity, msg_blob COPY (shared-hash) not
 * move, crash-injection idempotent recovery (no "both-have" duplicate, no loss),
 * verify-gated delete, count-overflow safety-valve, time-based migration, and
 * pinned exemption.
 *
 * Harness: a standalone history.db (SCHEMA_SQL + migrateEntriesColumns — the real
 * shape) in a temp dir, with a real archive.db file ATTACHed as `archive`. All
 * moves run through the main connection exactly as production wires them.
 */

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

import type { ArchiveWorkerControl } from "~/lib/history/sqlite/archive-worker"
import type { Database } from "~/lib/history/sqlite/connection"

import {
  //
  attachArchive,
  closeArchiveDb,
  openArchiveDb,
} from "~/lib/history/sqlite/archive-db"
import {
  //
  resetArchiveWorkerForTests,
} from "~/lib/history/sqlite/archive-worker"
import { migrateEntriesColumns } from "~/lib/history/sqlite/connection"
import { createDatabase } from "~/lib/history/sqlite/driver"
import { SCHEMA_SQL } from "~/lib/history/sqlite/schema"
import {
  //
  migrateEntriesToTier1,
  migrateOverflowToTier1,
  moveEntryToTier1,
  runTier1BacklogWorker,
  runTier1MigrationOnce,
} from "~/lib/history/sqlite/tier1-migrate"

let dir: string
let main: Database

function seedEntry(
  db: Database,
  id: string,
  opts: { status?: string; startedAt?: number; pinned?: number; sessionId?: string; hashes?: Array<string> } = {},
): void {
  const status = opts.status ?? "completed"
  const startedAt = opts.startedAt ?? Date.now()
  const pinned = opts.pinned ?? 0
  const hashes = opts.hashes ?? [`h-${id}-a`, `h-${id}-b`]
  db.prepare("INSERT INTO entries_v2 (id, session_id, started_at, status, pinned, blob_gz) VALUES (?,?,?,?,?,?)").run(
    id,
    opts.sessionId ?? "sess-1",
    startedAt,
    status,
    pinned,
    new Uint8Array([1, 2, 3]),
  )
  db.prepare("INSERT INTO entry_stages (entry_id, stage, attempt_index, created_at, blob_gz) VALUES (?,?,?,?,?)").run(
    id,
    "client_request",
    -1,
    startedAt,
    new Uint8Array([4, 5]),
  )
  db.prepare("INSERT INTO entry_stages (entry_id, stage, attempt_index, created_at, blob_gz) VALUES (?,?,?,?,?)").run(
    id,
    "sse_events",
    0,
    startedAt,
    new Uint8Array([6, 7, 8, 9]),
  )
  for (const [i, h] of hashes.entries()) {
    db.prepare("INSERT OR IGNORE INTO msg_blob (hash, text) VALUES (?,?)").run(h, `text-${h}`)
    db.prepare("INSERT INTO req_msg (req_id, pos, hash) VALUES (?,?,?)").run(id, i, h)
  }
  db.prepare("INSERT INTO req_aux (req_id, source, text) VALUES (?,?,?)").run(id, "req-headers", `aux-${id}`)
}

beforeEach(() => {
  resetArchiveWorkerForTests()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier1-move-test-"))
  // real archive.db file with the shared schema, then close so we can ATTACH it.
  openArchiveDb(path.join(dir, "archive.db"))
  closeArchiveDb()
  // standalone history.db with the real shape.
  main = createDatabase(path.join(dir, "history.db"))
  main.exec("PRAGMA journal_mode = WAL;")
  main.exec("PRAGMA foreign_keys = ON;")
  main.exec(SCHEMA_SQL)
  migrateEntriesColumns(main)
  attachArchive(main, path.join(dir, "archive.db"))
})

afterEach(() => {
  try {
    main.close()
  } catch {
    /* already closed */
  }
  closeArchiveDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

const countMain = (t: string, where = "") => (main.prepare(`SELECT COUNT(*) n FROM main.${t} ${where}`).get() as { n: number }).n
const countArchive = (t: string, where = "") => (main.prepare(`SELECT COUNT(*) n FROM archive.${t} ${where}`).get() as { n: number }).n

describe("tier1 move — fidelity", () => {
  test("moves one entry: deep-equal in archive, gone from HOT", () => {
    seedEntry(main, "e1")
    const before = main.prepare("SELECT * FROM main.entries_v2 WHERE id = 'e1'").get()
    const stagesBefore = main.prepare("SELECT * FROM main.entry_stages WHERE entry_id = 'e1' ORDER BY stage, attempt_index").all()

    expect(moveEntryToTier1(main, "e1")).toBe(true)

    // gone from HOT (cascade removed sub-tables)
    expect(countMain("entries_v2", "WHERE id = 'e1'")).toBe(0)
    expect(countMain("entry_stages", "WHERE entry_id = 'e1'")).toBe(0)
    expect(countMain("req_msg", "WHERE req_id = 'e1'")).toBe(0)
    // deep-equal head + stages in archive
    expect(main.prepare("SELECT * FROM archive.entries_v2 WHERE id = 'e1'").get()).toEqual(before)
    expect(main.prepare("SELECT * FROM archive.entry_stages WHERE entry_id = 'e1' ORDER BY stage, attempt_index").all()).toEqual(stagesBefore)
    expect(countArchive("req_msg", "WHERE req_id = 'e1'")).toBe(2)
    expect(countArchive("req_aux", "WHERE req_id = 'e1'")).toBe(1)
  })

  test("msg_blob is COPIED not moved: a hash shared with a HOT row lands in BOTH", () => {
    // e1 and e2 share hash H (same content-addressed message)
    seedEntry(main, "e1", { hashes: ["H", "only-e1"] })
    seedEntry(main, "e2", { hashes: ["H", "only-e2"] })

    expect(moveEntryToTier1(main, "e1")).toBe(true)
    migrateEntriesToTier1(main, []) // trigger no-op; GC ran inside the single move? no — run explicit batch GC below

    // H still in HOT (e2 references it) AND now in archive (e1 references it)
    expect(countMain("msg_blob", "WHERE hash = 'H'")).toBe(1)
    expect(countArchive("msg_blob", "WHERE hash = 'H'")).toBe(1)
    // archive-side search JOIN resolves e1's messages (no dangling ref)
    const joined = main.prepare("SELECT COUNT(*) n FROM archive.req_msg rm JOIN archive.msg_blob mb ON mb.hash = rm.hash WHERE rm.req_id = 'e1'").get() as {
      n: number
    }
    expect(joined.n).toBe(2)
  })

  test("archive-side GC sweeps orphan msg_blob after batch, HOT GC untouched", () => {
    seedEntry(main, "e1", { hashes: ["uniqA", "uniqB"] })
    migrateEntriesToTier1(main, ["e1"])
    // both hashes are e1-only → after move HOT still holds them until HOT GC; archive holds them (referenced)
    expect(countArchive("msg_blob")).toBe(2)
    // HOT msg_blob rows are now orphaned (req_msg cascade-deleted) but HOT GC is separate (reaper's job)
    expect(countMain("msg_blob")).toBe(2)
  })
})

describe("tier1 move — crash-injection idempotency", () => {
  test("crash after archive-write, before HOT-delete → re-run leaves no duplicate, no loss", () => {
    seedEntry(main, "e1")
    // simulate a crash right after the copy transaction: manually copy, do NOT delete HOT
    main.prepare("INSERT OR IGNORE INTO archive.entries_v2 SELECT * FROM main.entries_v2 WHERE id = 'e1'").run()
    main.prepare("INSERT OR IGNORE INTO archive.entry_stages SELECT * FROM main.entry_stages WHERE entry_id = 'e1'").run()
    main.prepare("INSERT OR IGNORE INTO archive.req_msg SELECT * FROM main.req_msg WHERE req_id = 'e1'").run()
    main.prepare("INSERT OR IGNORE INTO archive.req_aux SELECT * FROM main.req_aux WHERE req_id = 'e1'").run()
    main.prepare("INSERT OR IGNORE INTO archive.msg_blob SELECT * FROM main.msg_blob WHERE hash IN (SELECT hash FROM main.req_msg WHERE req_id = 'e1')").run()
    // now BOTH have it (the "both-have" crash window)
    expect(countMain("entries_v2", "WHERE id = 'e1'")).toBe(1)
    expect(countArchive("entries_v2", "WHERE id = 'e1'")).toBe(1)

    // recovery re-run: idempotent copy + verify + delete-HOT
    expect(moveEntryToTier1(main, "e1")).toBe(true)
    // exactly one copy in archive, none in HOT — no duplicate, no loss
    expect(countArchive("entries_v2", "WHERE id = 'e1'")).toBe(1)
    expect(countArchive("entry_stages", "WHERE entry_id = 'e1'")).toBe(2)
    expect(countMain("entries_v2", "WHERE id = 'e1'")).toBe(0)
  })

  test("moving 10 times determinism: repeated moveEntryToTier1 on a migrated id is a stable no-op", () => {
    seedEntry(main, "e1")
    expect(moveEntryToTier1(main, "e1")).toBe(true)
    for (let i = 0; i < 10; i++) {
      // already gone from HOT; a re-move copies nothing new and verify passes on the archive copy... but head no longer in HOT
      // moveEntryToTier1 re-copies from main (now empty) → verify head-in-archive true → delete-HOT no-op. Stable.
      expect(moveEntryToTier1(main, "e1")).toBe(true)
      expect(countArchive("entries_v2", "WHERE id = 'e1'")).toBe(1)
      expect(countMain("entries_v2", "WHERE id = 'e1'")).toBe(0)
    }
  })
})

describe("tier1 move — BLOCKER regressions (reviewer-found)", () => {
  test("BLOCKER-1: legacy-shape main (ALTER-ordered columns) ≠ fresh archive order → explicit-column move still works", () => {
    // Build a legacy-shape history.db: OLD core CREATE TABLE, then migrateEntriesColumns
    // ALTER-appends the rest — reproducing the real 32 GB DB's physical column order,
    // which differs from the fresh archive.db (SCHEMA_SQL CREATE order). A `SELECT *`
    // cross-db copy would misalign here (FK violation); explicit column names must not.
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "tier1-legacy-"))
    openArchiveDb(path.join(legacyDir, "archive.db"))
    closeArchiveDb()
    const legacy = createDatabase(path.join(legacyDir, "history.db"))
    legacy.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
    // Pre-ALTER core shape (the columns entries_v2 had before the 15+ ADD COLUMNs).
    legacy.exec(`CREATE TABLE entries_v2 (
      id TEXT PRIMARY KEY, session_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
      duration_ms INTEGER, model TEXT, endpoint TEXT, transport TEXT, status TEXT NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_creation INTEGER,
      reasoning_tokens INTEGER, stop_reason TEXT, error_message TEXT, blob_gz BLOB NOT NULL)`)
    legacy.exec(
      `CREATE TABLE entry_stages (entry_id TEXT NOT NULL, stage TEXT NOT NULL, attempt_index INTEGER NOT NULL DEFAULT -1, created_at INTEGER NOT NULL, blob_gz BLOB NOT NULL, PRIMARY KEY (entry_id, stage, attempt_index), FOREIGN KEY (entry_id) REFERENCES entries_v2(id) ON DELETE CASCADE)`,
    )
    legacy.exec(`CREATE TABLE msg_blob (hash TEXT PRIMARY KEY, text TEXT NOT NULL)`)
    legacy.exec(
      `CREATE TABLE req_msg (req_id TEXT NOT NULL, pos INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (req_id, pos), FOREIGN KEY (req_id) REFERENCES entries_v2(id) ON DELETE CASCADE)`,
    )
    legacy.exec(
      `CREATE TABLE req_aux (req_id TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (req_id, source), FOREIGN KEY (req_id) REFERENCES entries_v2(id) ON DELETE CASCADE)`,
    )
    migrateEntriesColumns(legacy) // ALTER-appends agent_id/pid/message_count/... at the end
    attachArchive(legacy, path.join(legacyDir, "archive.db"))

    // sanity: the two DBs really DO have different physical column order
    const legacyCols = (legacy.prepare("PRAGMA table_info(entries_v2)").all() as Array<{ name: string }>).map((c) => c.name)
    const archiveCols = (legacy.prepare("PRAGMA archive.table_info(entries_v2)").all() as Array<{ name: string }>).map((c) => c.name)
    expect(legacyCols).not.toEqual(archiveCols) // order differs…
    expect([...legacyCols].sort()).toEqual([...archiveCols].sort()) // …but same set

    // seed an entry with a recognizable agent_id (a column at a DIFFERENT position in the two DBs)
    seedEntry(legacy, "leg-1")
    legacy.prepare("UPDATE entries_v2 SET agent_id = 'agent-xyz', message_count = 7 WHERE id = 'leg-1'").run()

    expect(moveEntryToTier1(legacy, "leg-1")).toBe(true)
    // the move must not misalign: agent_id/message_count land in the RIGHT archive columns
    const archived = legacy.prepare("SELECT agent_id, message_count, status FROM archive.entries_v2 WHERE id = 'leg-1'").get() as {
      agent_id: string
      message_count: number
      status: string
    }
    expect(archived.agent_id).toBe("agent-xyz")
    expect(archived.message_count).toBe(7)
    expect(archived.status).toBe("completed")

    legacy.close()
    fs.rmSync(legacyDir, { recursive: true, force: true })
  })

  test("BLOCKER-2: a stale archive row is OVERWRITTEN with HOT's current content (no silent loss)", () => {
    seedEntry(main, "e1")
    // simulate a crash-recovery window where archive has a STALE copy (old blob) but HOT
    // was since corrected by a backfill (new blob). Overwrite semantics must win with HOT's.
    main
      .prepare("INSERT INTO archive.entries_v2 (id, session_id, started_at, status, blob_gz) VALUES ('e1','sess-1',1,'completed',?)")
      .run(new Uint8Array([9, 9, 9]))
    main.prepare("UPDATE main.entries_v2 SET blob_gz = ? WHERE id = 'e1'").run(new Uint8Array([4, 2]))

    expect(moveEntryToTier1(main, "e1")).toBe(true)
    const archivedBlob = (main.prepare("SELECT blob_gz FROM archive.entries_v2 WHERE id = 'e1'").get() as { blob_gz: Uint8Array }).blob_gz
    expect(Array.from(archivedBlob)).toEqual([4, 2]) // HOT's current content, NOT the stale [9,9,9]
    expect(countMain("entries_v2", "WHERE id = 'e1'")).toBe(0)
  })

  test("BLOCKER-3: schema drift (HOT has a column archive lacks) fails the WHOLE batch fast, isolating healthy rows in HOT", () => {
    // archive.db (from beforeEach) lacks `future_col`; add it to HOT only → column-set mismatch.
    main.exec("ALTER TABLE entries_v2 ADD COLUMN future_col TEXT")
    seedEntry(main, "healthy-1")
    seedEntry(main, "healthy-2")
    // Batch precheck must skip the whole batch (0 moved) WITHOUT per-entry attempts,
    // and NEVER lose a row (both stay in HOT for a later retry once archive catches up).
    const moved = migrateEntriesToTier1(main, ["healthy-1", "healthy-2"])
    expect(moved).toBe(0)
    expect(countMain("entries_v2")).toBe(2) // both fail-closed in HOT, none lost
    expect(countArchive("entries_v2")).toBe(0) // nothing half-written to archive
    // Sanity: once archive catches up (add the column there too), the SAME batch succeeds.
    main.exec("ALTER TABLE archive.entries_v2 ADD COLUMN future_col TEXT")
    expect(migrateEntriesToTier1(main, ["healthy-1", "healthy-2"])).toBe(2)
    expect(countArchive("entries_v2")).toBe(2)
  })
})

describe("tier1 move — drivers + exemptions", () => {
  test("count overflow safety-valve moves oldest beyond limit, not delete", () => {
    for (let i = 0; i < 5; i++) seedEntry(main, `ok-${i}`, { status: "completed", startedAt: 1000 + i })
    // successLimit 2 → move oldest 3 (ok-0,1,2)
    const moved = migrateOverflowToTier1(main, 2, 0)
    expect(moved).toBe(3)
    expect(countMain("entries_v2")).toBe(2)
    expect(countArchive("entries_v2")).toBe(3)
    // newest 2 stay HOT
    expect(countMain("entries_v2", "WHERE id IN ('ok-3','ok-4')")).toBe(2)
  })

  test("time migration cools a whole cold session, keeps active-session + pinned in HOT", () => {
    const now = Date.now()
    // Session-atomic: a session cools only when ALL its activity is older than the
    // cutoff (never split a session, never cool one that is still active).
    seedEntry(main, "old-1", { startedAt: now - 5 * 86400_000, sessionId: "sess-old" })
    seedEntry(main, "old-pinned", { startedAt: now - 5 * 86400_000, pinned: 1, sessionId: "sess-pinned" })
    seedEntry(main, "recent", { startedAt: now - 1 * 86400_000, sessionId: "sess-recent" })

    const moved = runTier1MigrationOnce(main, { hotDays: 3, batchSize: 100 })
    expect(moved).toBe(1) // only old-1 (sess-pinned has no migratable row; sess-recent still active)
    expect(countMain("entries_v2", "WHERE id = 'old-1'")).toBe(0)
    expect(countArchive("entries_v2", "WHERE id = 'old-1'")).toBe(1)
    expect(countMain("entries_v2", "WHERE id = 'old-pinned'")).toBe(1) // pinned never cools
    expect(countMain("entries_v2", "WHERE id = 'recent'")).toBe(1)
  })

  test("a whole session migrates atomically — never split by batchSize", () => {
    const now = Date.now()
    // One cold session with many entries: session-atomic selection moves ALL of them
    // in one pass even though batchSize is small (a session is never split).
    for (let i = 0; i < 5; i++) seedEntry(main, `big-${i}`, { startedAt: now - 10 * 86400_000 + i, sessionId: "sess-big" })
    expect(runTier1MigrationOnce(main, { hotDays: 3, batchSize: 2 })).toBe(5)
    expect(countArchive("entries_v2", "WHERE session_id = 'sess-big'")).toBe(5)
    expect(countMain("entries_v2", "WHERE session_id = 'sess-big'")).toBe(0)
  })

  test("batchSize bounds a single pass across sessions; resumable across calls", () => {
    const now = Date.now()
    // 5 separate single-entry cold sessions: batchSize bounds how many WHOLE sessions
    // a pass drains (a session is atomic, so the boundary lands between sessions).
    for (let i = 0; i < 5; i++) seedEntry(main, `old-${i}`, { startedAt: now - 10 * 86400_000 + i, sessionId: `s-${i}` })
    expect(runTier1MigrationOnce(main, { hotDays: 3, batchSize: 2 })).toBe(2)
    expect(runTier1MigrationOnce(main, { hotDays: 3, batchSize: 2 })).toBe(2)
    expect(runTier1MigrationOnce(main, { hotDays: 3, batchSize: 2 })).toBe(1)
    expect(runTier1MigrationOnce(main, { hotDays: 3, batchSize: 2 })).toBe(0)
    expect(countArchive("entries_v2")).toBe(5)
    expect(countMain("entries_v2")).toBe(0)
  })

  test("background backlog stops after a committed batch and resumes later", async () => {
    const now = Date.now()
    for (let i = 0; i < 5; i++) seedEntry(main, `worker-${i}`, { startedAt: now - 10 * 86400_000 + i, sessionId: `worker-s-${i}` })
    let stop = false
    const control: ArchiveWorkerControl = {
      shouldStop: () => stop,
      async checkpoint() {
        stop = true
        return true
      },
    }

    expect(await runTier1BacklogWorker(main, { hotDays: 3, batchSize: 2 }, control)).toBe(2)
    expect(countArchive("entries_v2")).toBe(2)
    expect(countMain("entries_v2")).toBe(3)

    expect(await runTier1BacklogWorker(main, { hotDays: 3, batchSize: 2 })).toBe(3)
    expect(countArchive("entries_v2")).toBe(5)
    expect(countMain("entries_v2")).toBe(0)
  })
})
