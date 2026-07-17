import consola from "consola"
import fs from "node:fs"
import { availableParallelism } from "node:os"
import path from "node:path"

import { state } from "~/lib/state"

import type { Database } from "./connection"

import {
  //
  getArchiveDb,
  resolveArchiveDir,
} from "./archive-db"
import {
  //
  archiveWorkerControl,
  type ArchiveWorkerControl,
  runArchiveUnits,
} from "./archive-worker"
import { getEntryById } from "./read"
import {
  //
  publishSealFile,
  sealFileNameForSession,
  writeSealUnit,
} from "./tier2-archive"

/**
 * TIER-1 per-session compaction ("tier-1 每 session-id 列式分表").
 *
 * The HOT→tier-1 migration keeps a session's SUMMARY row in archive.entries_v2 (the
 * session-index that feeds the list view + content-addressed search) but the HEAVY
 * payload — entry_stages (the 22.7 GB bulk on a real DB) — bloats archive.db. This
 * pass moves each tier-1 session's heavy data OUT of archive.db into its own
 * immutable columnar file `archive-t1-<session>-g<unit-hash>.db` (SAME column layout as tier-2, reusing
 * writeSealUnit) and drops the now-redundant entry_stages rows. archive.db shrinks
 * to a compact index; detail reads resolve entry → file via the `tier1_locator`
 * table (read.ts getEntryById), with a stages fallback for any not-yet-compacted row.
 *
 * NEVER single-threaded: sessions compact with bounded PARALLELISM (async streamed
 * zstd on the libuv threadpool). Per session it is crash-safe & idempotent: write
 * the file (temp→fsync→rename, deterministic unit hash → same-unit retry reuses), THEN in one
 * archive.db transaction insert the locators + delete that session's entry_stages.
 * A crash between leaves the stages intact (read still works) for a re-run. Additive
 * and resumable — it never touches the proven sync migration/reaper path.
 */

const COMPACT_CONCURRENCY = Math.max(1, Math.min(availableParallelism() - 1, 4))

/** Oldest-first tier-1 sessions that still have UN-compacted entries (stages in
 *  archive.db, no tier1_locator row yet). */
function uncompactedSessions(db: Database): Array<{ sessionId: string; entries: number }> {
  return db
    .prepare(
      `SELECT e.session_id AS sessionId, COUNT(*) AS entries
         FROM entries_v2 e
        WHERE e.session_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM tier1_locator l WHERE l.entry_id = e.id)
        GROUP BY e.session_id
        ORDER BY MIN(e.started_at) ASC`,
    )
    .all() as Array<{ sessionId: string; entries: number }>
}

/** Exact seal files currently referenced by this session's locators. */
function sessionSealFiles(db: Database, sessionId: string): Array<string> {
  return (db.prepare("SELECT DISTINCT seal_file FROM tier1_locator WHERE session_id = ?").all(sessionId) as Array<{ seal_file: string }>).map(
    ({ seal_file }) => seal_file,
  )
}

/** Assemble a session's tier-1 entries (from archive.db, oldest→newest) into full objects. */
function assembleArchiveSession(sessionId: string): Array<ReturnType<typeof getEntryById>> {
  const db = getArchiveDb()
  const ids = (db.prepare("SELECT id FROM entries_v2 WHERE session_id = ? ORDER BY started_at ASC, id ASC").all(sessionId) as Array<{ id: string }>).map(
    (r) => r.id,
  )
  return ids.map((id) => getEntryById(id, "archive"))
}

interface CompactStats {
  entries: number
  srcBytes: number
  dstBytes: number
}

/**
 * Compact ONE tier-1 session into its `archive-t1-<session>.db` columnar file and
 * drop its entry_stages from archive.db. Async (streamed zstd off-thread). Returns
 * per-session stats (0 when nothing assemblable). Crash-safe & idempotent.
 */
export async function compactTier1Session(sessionId: string, dir: string): Promise<CompactStats> {
  const db = getArchiveDb()
  const previousSealFiles = sessionSealFiles(db, sessionId)
  const entries = assembleArchiveSession(sessionId).flatMap((e) => (e ? [e] : []))
  if (entries.length === 0) return { entries: 0, srcBytes: 0, dstBytes: 0 }
  const srcBytes = entries.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0)

  const unitIdentity = JSON.stringify(entries.map((entry) => entry.id))
  const sealFile = sealFileNameForSession(sessionId, "t1", unitIdentity)
  const finalPath = path.join(dir, sealFile)
  const tmpPath = `${finalPath}.tmp`
  fs.rmSync(tmpPath, { force: true })

  const locators = await writeSealUnit(tmpPath, entries)
  const dstBytes = publishSealFile(tmpPath, finalPath)

  // One archive.db transaction: record locators, then drop the now-redundant heavy
  // stage rows for this session (the head row + search rows stay as the index).
  const insLoc = db.prepare("INSERT OR REPLACE INTO tier1_locator (entry_id, session_id, seal_file, index_in_session) VALUES (?, ?, ?, ?)")
  const delStages = db.prepare("DELETE FROM entry_stages WHERE entry_id = ?")
  const tx = db.transaction(() => {
    for (const loc of locators) {
      insLoc.run(loc.entryId, sessionId, sealFile, loc.indexInSession)
      delStages.run(loc.entryId)
    }
  })
  tx()

  // Incremental compaction rewrites the whole current session into a new
  // immutable generation. Remove an older generation only after the locator
  // transaction committed and a global DB query proves no entry references it.
  for (const previous of previousSealFiles) {
    if (previous === sealFile) continue
    const refs = (db.prepare("SELECT COUNT(*) AS n FROM tier1_locator WHERE seal_file = ?").get(previous) as { n: number }).n
    if (refs === 0) fs.rmSync(path.join(dir, previous), { force: true })
  }
  return { entries: entries.length, srcBytes, dstBytes }
}

/**
 * One compaction pass: move EVERY un-compacted tier-1 session's heavy data into its
 * columnar file, fanning out `COMPACT_CONCURRENCY` sessions in parallel. Emits a
 * live progress line. Returns entries compacted. Async; never-throws at the call site.
 */
export async function runTier1CompactOnce(opts?: { control?: ArchiveWorkerControl; concurrency?: number }): Promise<number> {
  if (!state.historyArchiveEnabled) return 0
  const db = getArchiveDb()
  const dir = resolveArchiveDir(state.historyArchiveDir, state.historyDbPath)
  fs.mkdirSync(dir, { recursive: true })

  const backlog = uncompactedSessions(db)
  if (backlog.length === 0) return 0
  const totalEntries = backlog.reduce((n, session) => {
    const { entries } = getArchiveDb().prepare("SELECT COUNT(*) AS entries FROM entries_v2 WHERE session_id = ?").get(session.sessionId) as { entries: number }
    return n + entries
  }, 0)

  let compactedEntries = 0
  let compactedSessions = 0
  let srcTotal = 0
  let dstTotal = 0

  await runArchiveUnits(
    backlog,
    opts?.concurrency ?? COMPACT_CONCURRENCY,
    async (session) => {
      const st = await compactTier1Session(session.sessionId, dir)
      compactedEntries += st.entries
      srcTotal += st.srcBytes
      dstTotal += st.dstBytes
      if (st.entries > 0) compactedSessions += 1
      return st
    },
    opts?.control ?? archiveWorkerControl,
  )
  const ratio = srcTotal > 0 ? (dstTotal / srcTotal) * 100 : 0
  consola.info(
    `[history/tier1] compacted ${compactedEntries}/${totalEntries} entries, ${compactedSessions} sessions → `
      + `columnar files, src ${(srcTotal / 1048576).toFixed(0)}MB → dst ${(dstTotal / 1048576).toFixed(0)}MB (${ratio.toFixed(1)}%)`,
  )
  // Reclaim the pages freed by the entry_stages deletions back to the OS.
  try {
    db.exec("PRAGMA incremental_vacuum;")
  } catch (err: unknown) {
    consola.debug("[history/tier1] incremental_vacuum after compaction failed (non-fatal)", err)
  }
  return compactedEntries
}

/** Startup-only background tier-1 compaction. Tracked by the History lifecycle. */
export function startTier1Compact(): Promise<void> {
  return runTier1CompactOnce()
    .then(() => undefined)
    .catch((err: unknown) => consola.warn("[history/tier1] compaction pass failed (startup continues)", err))
}
