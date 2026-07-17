import consola from "consola"
import fs from "node:fs"
import { availableParallelism } from "node:os"
import path from "node:path"

import { state } from "~/lib/state"

import type { ArchiveWorkerControl } from "./archive-worker"
import type { Database } from "./connection"

import {
  //
  getArchiveDb,
  resolveArchiveDir,
} from "./archive-db"
import {
  //
  archiveWorkerControl,
  runArchiveUnits,
} from "./archive-worker"
import { getEntryById } from "./read"
import {
  //
  publishSealFile,
  readSealedEntry,
  sealFileNameForSession,
  totalSealedBytes,
  writeSealUnit,
} from "./tier2-archive"

/**
 * TIER-1 → TIER-2 sealing (spec §3.2/§M1). When archive.db (tier-1) exceeds
 * `tier1_size_cap`, the OLDEST whole sessions are sealed into immutable
 * per-session cold units (format v2: columnar, whole-session, zstd-LDM — see
 * tier2-archive.ts) and their tier-1 rows removed. Never deleted, only cooled.
 *
 * ONE immutable seal file per claimed session generation; the session's current
 * tier-1 rows are never split. Later requests in an already-sealed session form a
 * new generation instead of overwriting the old file. Many sessions seal in PARALLEL: the CPU-heavy compression is
 * async (libuv threadpool), fanned out with bounded concurrency so memory stays
 * bounded. A live progress line reports processed/total entries + src/dst bytes.
 *
 * Crash safety per session: the seal file is written to a temp path, fsync'd,
 * atomically renamed, and ONLY THEN the manifest-write + tier-1-delete run in a
 * SINGLE archive.db transaction (§M1 — same file, atomic). A crash before it
 * leaves an orphan seal file that the next run reuses (deterministic hash of the
 * claimed entry ids), never a both-have duplicate or a loss.
 * Fully resumable: each call recomputes the backlog from current tier-1 state, so
 * already-sealed sessions are simply gone and the next run continues where it
 * stopped. Startup-only (T1→T2 is the expensive re-encode).
 */

/** Manifest columns — see the original note: target list differs from source ONLY
 *  in `entry_id ← id`. Explicit names (never `SELECT *`) — cross-table column
 *  positions are not guaranteed aligned. */
const MANIFEST_TARGET_COLS =
  "entry_id, session_id, agent_id, started_at, ended_at, duration_ms, model, endpoint, transport, status, "
  + "input_tokens, output_tokens, cache_read, cache_creation, reasoning_tokens, stop_reason, error_message, "
  + "message_count, preview_text, response_preview_text, request_bytes, response_bytes, multiplier, raw_path"
const MANIFEST_SOURCE_COLS = MANIFEST_TARGET_COLS.replace("entry_id,", "id,")

/** Bounded seal concurrency. Compression uses a 128 MB window (windowLog 27), so
 *  each in-flight seal holds a large context + the session's assembled JSON —
 *  cap the fan-out to keep peak memory sane while still using several cores. */
const SEAL_CONCURRENCY = Math.max(1, Math.min(availableParallelism() - 1, 4))

/**
 * LIVE data bytes of archive.db = (page_count − freelist_count) × page_size. The
 * per-session seal DELETEs rows in-transaction but does NOT reclaim (auto_vacuum
 * is INCREMENTAL — freed pages sit on the freelist until a later vacuum). So the
 * raw file size (page_count × page_size) does NOT shrink as we seal; measuring
 * LIVE bytes (excluding the freelist) lets the cap loop see progress and stop at
 * the right point WITHOUT forcing an immediate reclaim (deferred reclaim is fine).
 */
function archiveLiveBytes(db: Database): number {
  const pc = (db.prepare("PRAGMA page_count").get() as Record<string, number>).page_count
  const ps = (db.prepare("PRAGMA page_size").get() as Record<string, number>).page_size
  const free = (db.prepare("PRAGMA freelist_count").get() as Record<string, number>).freelist_count
  return (pc - free) * ps
}

/** Oldest-first list of tier-1 sessions with their entry counts (the seal backlog). */
function tier1SessionsOldestFirst(db: Database): Array<{ sessionId: string; entries: number }> {
  return (
    db
      .prepare(
        "SELECT session_id AS sessionId, COUNT(*) AS entries FROM entries_v2 WHERE session_id IS NOT NULL GROUP BY session_id ORDER BY MIN(started_at) ASC",
      )
      .all() as Array<{ sessionId: string; entries: number }>
  ).map((r) => ({ sessionId: r.sessionId, entries: r.entries }))
}

/** Assemble every tier-1 entry of a session (oldest→newest) into full HistoryEntry objects. */
function assembleSessionEntries(sessionId: string): Array<ReturnType<typeof getEntryById>> {
  const db = getArchiveDb()
  const ids = (db.prepare("SELECT id FROM entries_v2 WHERE session_id = ? ORDER BY started_at ASC, id ASC").all(sessionId) as Array<{ id: string }>).map(
    (r) => r.id,
  )
  return ids.map((id) => getEntryById(id, "archive"))
}

interface SealStats {
  entries: number
  srcBytes: number
  dstBytes: number
}

/**
 * Seal ONE whole session from tier-1 into its own tier-2 unit
 * (`archive-t2-<session-id>-g<unit-hash>.db`). Async
 * (compression runs off-thread). Returns per-session stats (0 entries when the
 * session had nothing assemblable). Crash-safe: temp→fsync→rename, then
 * manifest+delete in one archive.db transaction. A deterministic unit hash makes
 * the same recovery attempt idempotent without overwriting older generations.
 */
export async function sealSession(sessionId: string, dir: string): Promise<SealStats> {
  const db = getArchiveDb()
  const entries = assembleSessionEntries(sessionId).flatMap((e) => (e ? [e] : []))
  if (entries.length === 0) return { entries: 0, srcBytes: 0, dstBytes: 0 }

  const srcBytes = entries.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0)

  const unitIdentity = JSON.stringify(entries.map((entry) => entry.id))
  const sealFile = sealFileNameForSession(sessionId, "t2", unitIdentity)
  const finalPath = path.join(dir, sealFile)
  const tmpPath = `${finalPath}.tmp`
  fs.rmSync(tmpPath, { force: true })

  // 1. write the seal unit to a temp file, fsync, atomic rename.
  const locators = await writeSealUnit(tmpPath, entries)
  const dstBytes = publishSealFile(tmpPath, finalPath)

  // 2. manifest-write + tier-1-delete in ONE archive.db transaction (§M1).
  const insManifest = db.prepare(
    `INSERT OR REPLACE INTO tier2_manifest (${MANIFEST_TARGET_COLS}, seal_file, index_in_session) SELECT ${MANIFEST_SOURCE_COLS}, ?, ? FROM entries_v2 WHERE id = ?`,
  )
  const delTier1Locator = db.prepare("DELETE FROM tier1_locator WHERE entry_id = ?")
  const delHead = db.prepare("DELETE FROM entries_v2 WHERE id = ?")
  const tx = db.transaction(() => {
    for (const loc of locators) {
      insManifest.run(sealFile, loc.indexInSession, loc.entryId)
      delTier1Locator.run(loc.entryId)
      delHead.run(loc.entryId)
    }
  })
  tx()
  return { entries: entries.length, srcBytes, dstBytes }
}

/** Sweep archive-side msg_blob rows orphaned by a batch of tier-1 deletions. */
function gcArchiveOrphanMsgBlobs(db: Database): void {
  db.prepare("DELETE FROM msg_blob WHERE NOT EXISTS (SELECT 1 FROM req_msg WHERE req_msg.hash = msg_blob.hash)").run()
}

/**
 * Rename pre-existing legacy seal units `archive-NNNN.db` → the new deterministic
 * `archive-t2-<session-id>.db` scheme, updating each unit's manifest `seal_file`
 * pointer in lock-step. The old server sealed ONE session per numbered file, so a
 * unit maps to exactly one session; a unit whose manifest rows span >1 session (or
 * none) is left untouched (can't map to a single session name). The file CONTENT is
 * untouched — readSealedEntry auto-detects v1 vs v2 — so this is a pure rename +
 * pointer update, safe to run every startup (idempotent: already-renamed files no
 * longer match the legacy pattern). Best-effort per file; never throws the pass.
 */
function renameLegacySealUnits(db: Database, dir: string): void {
  if (!fs.existsSync(dir)) return
  const legacy = fs.readdirSync(dir).filter((f) => /^archive-\d{4}\.db$/.test(f))
  for (const file of legacy) {
    try {
      const sids = db.prepare("SELECT DISTINCT session_id FROM tier2_manifest WHERE seal_file = ?").all(file) as Array<{ session_id: string | null }>
      if (sids.length === 0) {
        // A prior run may have committed the manifest update and crashed before
        // deleting the legacy source. No manifest references it now.
        fs.rmSync(path.join(dir, file), { force: true })
        continue
      }
      if (sids.length !== 1 || sids[0].session_id === null) continue // ambiguous → leave as-is
      const target = sealFileNameForSession(sids[0].session_id)
      if (target === file) continue
      const to = path.join(dir, target)
      // Recoverable cross-artifact update: copy+fsync target first while the old
      // manifest/file pair remains readable, then update all pointers in one DB
      // transaction, finally delete the legacy source. Every crash prefix is
      // readable and the next startup can replay it.
      if (!fs.existsSync(to)) {
        const tmp = `${to}.tmp`
        fs.copyFileSync(path.join(dir, file), tmp)
        publishSealFile(tmp, to)
      }
      db.prepare("UPDATE tier2_manifest SET seal_file = ? WHERE seal_file = ?").run(target, file)
      fs.rmSync(path.join(dir, file), { force: true })
      consola.info(`[history/tier2] renamed legacy seal unit ${file} → ${target}`)
    } catch (err: unknown) {
      consola.warn(`[history/tier2] failed to migrate legacy seal unit ${file} (will retry next startup)`, err)
    }
  }
}

/**
 * One sealing pass: while archive.db exceeds `tier1_size_cap`, seal the oldest
 * WHOLE sessions into tier-2, fanning out `SEAL_CONCURRENCY` sessions in parallel.
 * Emits a live progress line and the tier-2 growth warnings. Returns the number of
 * entries sealed. Async (parallel compression); never-throws at the call site.
 */
export async function runTier2SealOnce(opts?: { control?: ArchiveWorkerControl; concurrency?: number }): Promise<number> {
  if (!state.historyArchiveEnabled) return 0
  const db = getArchiveDb()
  const dir = resolveArchiveDir(state.historyArchiveDir, state.historyDbPath)
  fs.mkdirSync(dir, { recursive: true })

  renameLegacySealUnits(db, dir) // migrate any old archive-NNNN.db → archive-t2-<session>.db (runs regardless of cap)

  if (archiveLiveBytes(db) <= state.historyArchiveTier1SizeCap) return 0

  const backlog = tier1SessionsOldestFirst(db)
  const totalEntries = backlog.reduce((n, s) => n + s.entries, 0)

  let sealedEntries = 0
  let sealedSessions = 0
  let srcTotal = 0
  let dstTotal = 0
  const control = opts?.control ?? archiveWorkerControl
  const concurrency = opts?.concurrency ?? SEAL_CONCURRENCY
  let stalled = false

  // A session is one durable unit. Workers claim one session at a time and
  // checkpoint after its file+manifest commit; shutdown prevents the next claim.
  await runArchiveUnits(
    backlog,
    concurrency,
    async (session) => {
      if (stalled || archiveLiveBytes(db) <= state.historyArchiveTier1SizeCap) return { entries: 0, srcBytes: 0, dstBytes: 0 }
      const st = await sealSession(session.sessionId, dir)
      sealedEntries += st.entries
      srcTotal += st.srcBytes
      dstTotal += st.dstBytes
      if (st.entries > 0) {
        sealedSessions += 1
        gcArchiveOrphanMsgBlobs(db)
      } else {
        stalled = true
        consola.warn(`[history/tier2] session ${session.sessionId} sealed 0 entries while over cap — sealing stalled, needs attention`)
      }

      const ratio = srcTotal > 0 ? (dstTotal / srcTotal) * 100 : 0
      consola.info(
        `[history/tier2] sealing… ${sealedEntries}/${totalEntries} entries, ${sealedSessions} sessions, `
          + `src ${(srcTotal / 1048576).toFixed(0)}MB → dst ${(dstTotal / 1048576).toFixed(0)}MB (${ratio.toFixed(1)}%), `
          + `archive live ${(archiveLiveBytes(db) / 1073741824).toFixed(2)}GB / cap ${(state.historyArchiveTier1SizeCap / 1073741824).toFixed(2)}GB`,
      )
      return st
    },
    {
      shouldStop: () => stalled || archiveLiveBytes(db) <= state.historyArchiveTier1SizeCap || control.shouldStop(),
      checkpoint: () => control.checkpoint(),
    },
  )

  if (sealedEntries > 0) {
    const { count, bytes } = totalSealedBytes(dir)
    consola.info(
      `[history/tier2] sealed ${sealedEntries} entries across ${sealedSessions} sessions (${count} seal units, ${(bytes / 1048576).toFixed(0)}MB total)`,
    )
    if (count > state.historyArchiveTier2WarnCount)
      consola.warn(
        `[history/tier2] ${count} seal units exceeds tier2_warn_count=${state.historyArchiveTier2WarnCount} — consider offline archival (files are NEVER auto-deleted)`,
      )
    if (bytes > state.historyArchiveTier2WarnBytes)
      consola.warn(
        `[history/tier2] tier-2 total ${(bytes / 1048576).toFixed(0)}MB exceeds tier2_warn_bytes — consider offline archival (files are NEVER auto-deleted)`,
      )
  }
  return sealedEntries
}

/**
 * Read a sealed (tier-2) entry back via the manifest locator. Used by the archive
 * VIEW's detail fallback. SYNChronous (queries.ts resolves inline).
 */
export function readTier2Entry(entryId: string): ReturnType<typeof getEntryById> {
  const db = getArchiveDb()
  const row = db.prepare("SELECT seal_file, session_id, index_in_session FROM tier2_manifest WHERE entry_id = ?").get(entryId) as
    | { seal_file: string; session_id: string | null; index_in_session: number }
    | undefined
  if (!row) return undefined
  const dir = resolveArchiveDir(state.historyArchiveDir, state.historyDbPath)
  // Pass session_id so a pre-upgrade v1 seal unit (chunk_key = session#chunk) stays readable.
  return readSealedEntry(path.join(dir, row.seal_file), row.index_in_session, row.session_id ?? undefined)
}

/** Startup-only background seal (T1→T2). Tracked by the History lifecycle. */
export function startTier2Seal(): Promise<void> {
  return runTier2SealOnce()
    .then(() => undefined)
    .catch((err: unknown) => consola.warn("[history/tier2] seal pass failed (startup continues)", err))
}
