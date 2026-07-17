#!/usr/bin/env bun
/**
 * Offline high-performance tiered-archive compactor.
 *
 * WHY THIS EXISTS
 * ---------------
 * The in-server archive path (reaper tick + startup drain) is deliberately
 * bounded — small batches, gated on `hot_days` / `tier1_size_cap` — so it never
 * blocks live serving. That is the WRONG shape for a one-off bulk compaction of
 * a database that has already blown up (observed: a 26 GB HOT history.db + a
 * 10.4 GB tier-1 archive.db with only ~125 rows ever sealed to tier-2). Draining
 * that in-server would take days of reaper ticks, and a naive "archive it all
 * now" is exactly what OOM-crashed WSL — a single giant copy→verify→delete
 * transaction holds BOTH databases at full size at once and balloons the -wal.
 *
 * This script is the offline counterpart: it runs with the server STOPPED (so it
 * owns the files exclusively and can reclaim space with `incremental_vacuum` +
 * `wal_checkpoint(TRUNCATE)` between batches — no contention, no giant WAL), and
 * it reuses the SAME crash-safe primitives as the server (no reimplementation):
 *
 *   - `migrateEntriesToTier1` — HOT→tier-1 copy→verify→delete, per-entry atomic,
 *     idempotent, with content-addressed `INSERT OR IGNORE` msg_blob DEDUP.
 *   - `sealSession`           — tier-1→tier-2 session-group max-zstd seal (the 9×
 *     lever: one zstd window collapses the cross-request redundancy of a growing
 *     conversation), temp→fsync→rename + single manifest+delete transaction.
 *
 * DEDUP (user's explicit red line — "腾的时候一定要去重"):
 *   Both moves are dedup-preserving by construction:
 *   - HOT→tier-1: msg_blob is content-addressed (hash PK); `copyEntryToArchive`
 *     copies it `INSERT OR IGNORE`, so a hash shared across N requests lands ONCE.
 *   - tier-1→tier-2: a whole session is compressed as ONE JSON array in ONE zstd
 *     stream, so the huge per-request conversation overlap collapses.
 *   After every phase we also sweep orphaned msg_blob rows on BOTH sides.
 *
 * NULL-session orphans (a real gap in the in-server seal path):
 *   `oldestTier1Session` / `sealSession` filter `WHERE session_id IS NOT NULL`,
 *   so tier-1 rows with a NULL session_id can NEVER be sealed and pile up in
 *   tier-1 forever. This script seals them too, by first stamping them with a
 *   synthetic session id (they had none) so the standard `sealSession` path
 *   applies unchanged and the tier-2 manifest stays self-consistent on read-back.
 *
 * ORDER (user's decision — minimise peak disk by emptying tier-1 first):
 *   Phase 1: tier-1 → tier-2   (drain the existing 10.4 GB archive.db to sealed units)
 *   Phase 2: HOT   → tier-1    (move the 26 GB history.db into the now-empty archive.db)
 *   Phase 3: tier-1 → tier-2   (seal the freshly-moved rows down)
 *   Final:   reclaim both files' freelist to the OS + truncate both WALs.
 *
 * SAFETY:
 *   - Refuses to run while the main server is listening on 4141 (would contend
 *     for the exclusive VACUUM/checkpoint and risk a torn cross-db move). Stop
 *     the server first. Pass --force to override (you accept the contention).
 *   - Never deletes without first verifying the copy landed (server primitives'
 *     invariant). Every step is idempotent — safe to re-run after any interruption.
 *   - --dry-run reports the plan (counts + sizes) and writes nothing.
 *
 * USAGE:
 *   # 1. stop the server first (Ctrl-C the `bun run start`, or the systemd/pm2 unit)
 *   bun run scripts/offline-archiver.ts --dry-run     # report only
 *   bun run scripts/offline-archiver.ts               # run all 3 phases + reclaim
 *   bun run scripts/offline-archiver.ts --batch=500   # HOT→tier1 batch size (default 300)
 *   bun run scripts/offline-archiver.ts --force       # run even if 4141 is up (NOT recommended)
 */

import consola from "consola"
import { execSync } from "node:child_process"
import fs from "node:fs"

import { PATHS } from "~/lib/config/paths"
import {
  //
  closeArchiveDb,
  ensureArchiveAttachedToMain,
  getArchiveDb,
  migrateArchiveDb,
  openConfiguredArchiveDb,
  resolveArchiveDir,
} from "~/lib/history/sqlite/archive-db"
import {
  //
  closeDatabase,
  getDatabase,
  incrementalVacuum,
  openDatabase,
} from "~/lib/history/sqlite/connection"
import { migrateEntriesToTier1 } from "~/lib/history/sqlite/tier1-migrate"
import { sealSession } from "~/lib/history/sqlite/tier2-seal"
import { state } from "~/lib/state"

/** Synthetic session id stamped onto NULL-session tier-1 orphans so the standard seal path can process them. */
const ORPHAN_SESSION_ID = "__orphan_null_session__"

interface Options {
  dryRun: boolean
  force: boolean
  batchSize: number
}

function parseArgs(argv: ReadonlyArray<string>): Options {
  let dryRun = false
  let force = false
  let batchSize = 300
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true
    else if (arg === "--force") force = true
    else if (arg.startsWith("--batch=")) batchSize = Math.max(1, Number(arg.slice("--batch=".length)) || 300)
    else throw new Error(`unknown argument: ${arg}`)
  }
  return { dryRun, force, batchSize }
}

const MB = 1048576
const fmtMB = (bytes: number) => `${(bytes / MB).toFixed(0)}MB`

/** File size on disk of a db + its -wal (0 if absent). */
function dbFileBytes(path: string): number {
  const one = (p: string) => (fs.existsSync(p) ? fs.statSync(p).size : 0)
  return one(path) + one(`${path}-wal`)
}

/** Is the main server currently listening on 4141? (best-effort; ss then lsof). */
function serverIsUp(): boolean {
  try {
    const out = execSync("ss -ltn 2>/dev/null || true", { encoding: "utf8" })
    return /:4141\b/.test(out)
  } catch {
    return false
  }
}

/** Data-level size of an open db (page_count × page_size — independent of WAL). */
function dataBytes(db: ReturnType<typeof getDatabase>): number {
  const pc = (db.prepare("PRAGMA page_count").get() as Record<string, number>).page_count
  const ps = (db.prepare("PRAGMA page_size").get() as Record<string, number>).page_size
  return pc * ps
}

/** Reclaim an open db's freed pages to the OS and truncate its WAL back to zero. */
function reclaim(db: ReturnType<typeof getDatabase>, label: string): void {
  const before = dataBytes(db)
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);")
  incrementalVacuum(db)
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);")
  const after = dataBytes(db)
  consola.info(`[archiver] ${label} reclaimed ${fmtMB(before - after)} (data ${fmtMB(before)} → ${fmtMB(after)})`)
}

/**
 * Phase tier-1 → tier-2: seal EVERY session out of archive.db into cold sealed
 * units, then the NULL-session orphans, until tier-1 (archive.entries_v2) is
 * empty. Reclaims archive.db space every few sessions so its file shrinks as it
 * drains rather than holding the high-water mark until the very end.
 */
async function sealAllTier1(dir: string): Promise<number> {
  const db = getArchiveDb()
  let sealedTotal = 0
  let sinceReclaim = 0

  // 1) Real sessions (oldest first — mirrors the server's seal ordering).
  for (;;) {
    const row = db.prepare("SELECT session_id FROM entries_v2 WHERE session_id IS NOT NULL GROUP BY session_id ORDER BY MIN(started_at) ASC LIMIT 1").get() as
      | { session_id: string }
      | undefined
    if (!row) break
    const { entries: n } = await sealSession(row.session_id, dir)
    if (n === 0) {
      consola.warn(`[archiver] session ${row.session_id} sealed 0 entries (unassemblable?) — skipping to avoid an infinite loop`)
      // Stamp it out of the way so we don't re-select it forever; it stays in
      // tier-1 (never lost) but no longer blocks the drain.
      db.prepare("UPDATE entries_v2 SET session_id = session_id || '#unsealable' WHERE session_id = ?").run(row.session_id)
      continue
    }
    sealedTotal += n
    if (++sinceReclaim >= 25) {
      reclaim(db, "archive.db (mid-seal)")
      sinceReclaim = 0
    }
    if (sealedTotal % 500 < n) consola.info(`[archiver] tier1→tier2: ${sealedTotal} entries sealed so far`)
  }

  // 2) NULL-session orphans — the in-server seal path can NEVER reach these.
  //    Stamp a synthetic session id so the standard sealSession path applies.
  const orphans = (db.prepare("SELECT COUNT(*) n FROM entries_v2 WHERE session_id IS NULL").get() as { n: number }).n
  if (orphans > 0) {
    consola.info(`[archiver] tier1→tier2: sealing ${orphans} NULL-session orphan row(s) under synthetic session ${ORPHAN_SESSION_ID}`)
    db.prepare("UPDATE entries_v2 SET session_id = ? WHERE session_id IS NULL").run(ORPHAN_SESSION_ID)
    sealedTotal += (await sealSession(ORPHAN_SESSION_ID, dir)).entries
  }

  reclaim(db, "archive.db (post-seal)")
  return sealedTotal
}

/**
 * Phase HOT → tier-1: move ALL terminal, non-pinned rows out of history.db into
 * archive.db (tier-1), oldest first, in bounded batches. Unlike the server's
 * age-gated drain this ignores `hot_days` (the user wants HOT emptied). Reclaims
 * history.db space after every batch so the two files never both sit at full
 * size — the peak-disk / OOM guard that a single giant "archive now" lacked.
 */
function drainAllHotToTier1(main: ReturnType<typeof getDatabase>, batchSize: number): number {
  const MIGRATABLE_WHERE = "status IN ('completed','failed','aborted','interrupted') AND pinned = 0"
  let movedTotal = 0
  for (;;) {
    const ids = (
      main.prepare(`SELECT id FROM main.entries_v2 WHERE ${MIGRATABLE_WHERE} ORDER BY started_at ASC, id ASC LIMIT ?`).all(batchSize) as Array<{ id: string }>
    ).map((r) => r.id)
    if (ids.length === 0) break
    const moved = migrateEntriesToTier1(main, ids)
    movedTotal += moved
    // Reclaim HOT space + truncate the WAL every batch so history.db shrinks as
    // it drains instead of holding its 26 GB high-water mark until the end.
    reclaim(main, `history.db (after batch, ${movedTotal} moved)`)
    if (moved < ids.length) {
      consola.warn(
        `[archiver] batch moved ${moved}/${ids.length} — ${ids.length - moved} row(s) left in HOT (verify failed / schema drift); stopping to avoid a hot loop`,
      )
      break
    }
  }
  return movedTotal
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const historyPath = state.historyDbPath || PATHS.HISTORY_DB

  if (serverIsUp() && !opts.force) {
    consola.error(
      "[archiver] the main server appears to be LISTENING on 4141. This offline compactor needs exclusive access "
        + "(it runs VACUUM/checkpoint(TRUNCATE) between batches). Stop the server first, then re-run. "
        + "Pass --force to run anyway (accepts contention / SQLITE_BUSY risk — NOT recommended).",
    )
    process.exit(1)
  }

  consola.info(`[archiver] HOT history.db: ${historyPath}`)
  openDatabase(historyPath)
  const main = getDatabase()

  if (!state.historyArchiveEnabled) {
    consola.warn(
      "[archiver] history.archive.enabled is false in config — the archive.db path resolution still works, continuing (offline compaction is explicit).",
    )
  }
  openConfiguredArchiveDb()
  await migrateArchiveDb() // keep archive.db schema in lockstep with HOT before any cross-db move
  ensureArchiveAttachedToMain(main) // ATTACH archive AS `archive` for the tier-1 move
  const archive = getArchiveDb()
  const dir = resolveArchiveDir(state.historyArchiveDir, historyPath)

  const hotBefore = dbFileBytes(historyPath)
  const arcBefore = dataBytes(archive)
  const hotRows = (
    main.prepare("SELECT COUNT(*) n FROM main.entries_v2 WHERE status IN ('completed','failed','aborted','interrupted') AND pinned = 0").get() as { n: number }
  ).n
  const tier1Rows = (archive.prepare("SELECT COUNT(*) n FROM entries_v2").get() as { n: number }).n

  consola.box(
    `Offline tiered-archive compaction plan${opts.dryRun ? " (DRY RUN)" : ""}\n`
      + `  HOT history.db : ${fmtMB(hotBefore)} on disk, ${hotRows} migratable rows\n`
      + `  tier-1 archive : ${fmtMB(arcBefore)} data, ${tier1Rows} rows\n`
      + `  seal dir       : ${dir}\n`
      + `  order          : tier1→tier2 → HOT→tier1 → tier1→tier2 → reclaim\n`
      + `  batch (HOT)    : ${opts.batchSize}`,
  )

  if (opts.dryRun) {
    consola.info("[archiver] dry-run: no writes. Re-run without --dry-run to execute.")
    closeDatabase()
    closeArchiveDb()
    return
  }

  const t0 = Date.now()

  // ── Phase 1: tier-1 → tier-2 (empty the existing archive.db) ────────────────
  consola.start("[archiver] Phase 1/3: tier-1 → tier-2 (seal existing archive.db)")
  const sealed1 = await sealAllTier1(dir)
  consola.success(`[archiver] Phase 1 done: sealed ${sealed1} entries; archive.db now ${fmtMB(dataBytes(archive))}`)

  // ── Phase 2: HOT → tier-1 (move history.db into the now-empty archive) ──────
  consola.start("[archiver] Phase 2/3: HOT → tier-1 (move history.db → archive.db, dedup-preserving)")
  const moved = drainAllHotToTier1(main, opts.batchSize)
  consola.success(`[archiver] Phase 2 done: moved ${moved} entries HOT→tier-1; history.db now ${fmtMB(dbFileBytes(historyPath))}`)

  // ── Phase 3: tier-1 → tier-2 (seal the freshly-moved rows) ──────────────────
  consola.start("[archiver] Phase 3/3: tier-1 → tier-2 (seal freshly-moved rows)")
  const sealed3 = await sealAllTier1(dir)
  consola.success(`[archiver] Phase 3 done: sealed ${sealed3} entries`)

  // ── Final reclaim on both files ─────────────────────────────────────────────
  reclaim(main, "history.db (final)")
  reclaim(archive, "archive.db (final)")

  const hotAfter = dbFileBytes(historyPath)
  const arcAfter = dbFileBytes(resolveArchiveDbPathSafe(dir))
  consola.box(
    `Compaction complete in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`
      + `  history.db : ${fmtMB(hotBefore)} → ${fmtMB(hotAfter)}\n`
      + `  archive.db : ${fmtMB(arcBefore)} → ${fmtMB(arcAfter)} (rest is now in cold sealed units)\n`
      + `  sealed     : ${sealed1 + sealed3} entries total across both seal passes`,
  )

  closeDatabase()
  closeArchiveDb()
}

/** archive.db file path from the seal dir (dir/archive.db); tolerant of the :memory: case. */
function resolveArchiveDbPathSafe(dir: string): string {
  return dir === ":memory:" ? ":memory:" : `${dir}/archive.db`
}

await main()
