import consola from "consola"
import fs from "node:fs"
import path from "node:path"

import { state } from "~/lib/state"

import type { Database } from "./connection"

import { getArchiveDb, resolveArchiveDir } from "./archive-db"
import { getEntryById } from "./read"
import { nextSealFileName, readSealedEntry, totalSealedBytes, writeSealUnit, type SealedLocator } from "./tier2-archive"

/**
 * TIER-1 → TIER-2 sealing (spec §3.2/§M1, Phase 0 verdict SQLite sealed +
 * session-group). When archive.db (tier-1) exceeds `tier1_size_cap`, the OLDEST
 * whole sessions are sealed into immutable numbered cold units and their tier-1
 * rows removed — never deleted, only cooled further.
 *
 * Crash safety: the seal file is written to a temp path, fsync'd, atomically
 * renamed into place, and ONLY THEN is the manifest-write + tier-1-delete done in
 * a SINGLE archive.db transaction (§M1 — same file, so it IS atomic; a crash
 * before it leaves an orphan seal file that a re-run supersedes, never a
 * both-have duplicate or a loss). Startup-only per the user's trigger decision
 * (T1→T2 is the expensive re-encode; not on the periodic tick). Never-throws.
 */

/**
 * Manifest columns. The tier2_manifest PK is `entry_id` but the source column in
 * entries_v2 is `id`; every other meta column shares its name. So the INSERT
 * target list and the SELECT source list differ ONLY in that first column
 * (entry_id ← id). Explicit names (not `SELECT *`) — same discipline as the
 * tier-1 move (BLOCKER-1): never assume cross-table column position alignment.
 */
const MANIFEST_TARGET_COLS =
  "entry_id, session_id, agent_id, started_at, ended_at, duration_ms, model, endpoint, transport, status, " +
  "input_tokens, output_tokens, cache_read, cache_creation, reasoning_tokens, stop_reason, error_message, " +
  "message_count, preview_text, response_preview_text, request_bytes, response_bytes, multiplier, raw_path"
const MANIFEST_SOURCE_COLS = MANIFEST_TARGET_COLS.replace("entry_id,", "id,")

/** Current archive.db size in bytes (page_count × page_size — works for file + memory). */
function archiveDbBytes(db: Database): number {
  const pc = (db.prepare("PRAGMA page_count").get() as Record<string, number>).page_count
  const ps = (db.prepare("PRAGMA page_size").get() as Record<string, number>).page_size
  return pc * ps
}

/** The oldest session_id still living in tier-1 (archive.entries_v2), or undefined when empty. */
function oldestTier1Session(db: Database): string | undefined {
  const row = db.prepare("SELECT session_id FROM entries_v2 WHERE session_id IS NOT NULL GROUP BY session_id ORDER BY MIN(started_at) ASC LIMIT 1").get() as
    | { session_id: string }
    | undefined
  return row?.session_id
}

/** Assemble every tier-1 entry of a session (oldest→newest) into full HistoryEntry objects. */
function assembleSessionEntries(sessionId: string): Array<{ id: string; entry: ReturnType<typeof getEntryById> }> {
  const db = getArchiveDb()
  const ids = (db.prepare("SELECT id FROM entries_v2 WHERE session_id = ? ORDER BY started_at ASC, id ASC").all(sessionId) as Array<{ id: string }>).map((r) => r.id)
  return ids.map((id) => ({ id, entry: getEntryById(id, "archive") }))
}

/**
 * Seal ONE session from tier-1 into a tier-2 unit. Returns the number of entries
 * sealed (0 if the session had no assemblable entries). Idempotent-safe via the
 * temp→rename seal file + single manifest+delete transaction.
 */
export function sealSession(sessionId: string, dir: string): number {
  const db = getArchiveDb()
  const assembled = assembleSessionEntries(sessionId)
  const entries = assembled.flatMap((a) => (a.entry ? [a.entry] : []))
  if (entries.length === 0) return 0

  const sealFile = nextSealFileName(dir)
  const finalPath = path.join(dir, sealFile)
  const tmpPath = `${finalPath}.tmp`
  fs.rmSync(tmpPath, { force: true })

  // 1. write the seal unit to a temp file, fsync, atomic rename.
  const locators: Array<SealedLocator> = writeSealUnit(tmpPath, sessionId, entries)
  const fd = fs.openSync(tmpPath, "r")
  fs.fsyncSync(fd)
  fs.closeSync(fd)
  fs.renameSync(tmpPath, finalPath)

  // 2. manifest-write + tier-1-delete in ONE archive.db transaction (§M1).
  const insManifest = db.prepare(`INSERT OR REPLACE INTO tier2_manifest (${MANIFEST_TARGET_COLS}, seal_file, index_in_session) SELECT ${MANIFEST_SOURCE_COLS}, ?, ? FROM entries_v2 WHERE id = ?`)
  const delHead = db.prepare("DELETE FROM entries_v2 WHERE id = ?")
  const tx = db.transaction(() => {
    for (const loc of locators) {
      insManifest.run(sealFile, loc.indexInSession, loc.entryId)
      delHead.run(loc.entryId)
    }
    // Sweep archive-side msg_blob rows orphaned by the tier-1 deletions.
    db.prepare("DELETE FROM msg_blob WHERE NOT EXISTS (SELECT 1 FROM req_msg WHERE req_msg.hash = msg_blob.hash)").run()
  })
  tx()
  return entries.length
}

/**
 * One sealing pass: while archive.db exceeds `tier1_size_cap`, seal the oldest
 * session into tier-2. Bounded by the number of distinct sessions (never loops
 * forever). Emits the tier-2 growth warnings. Returns the number of entries sealed.
 */
export function runTier2SealOnce(): number {
  if (!state.historyArchiveEnabled) return 0
  const db = getArchiveDb()
  const dir = resolveArchiveDir(state.historyArchiveDir, state.historyDbPath)
  fs.mkdirSync(dir, { recursive: true })

  let sealed = 0
  // Guard against an unbounded loop: cap iterations at the current session count.
  let guard = (db.prepare("SELECT COUNT(DISTINCT session_id) n FROM entries_v2").get() as { n: number }).n + 1
  while (archiveDbBytes(db) > state.historyArchiveTier1SizeCap && guard-- > 0) {
    const sessionId = oldestTier1Session(db)
    if (!sessionId) break
    sealed += sealSession(sessionId, dir)
  }

  if (sealed > 0) {
    const { count, bytes } = totalSealedBytes(dir)
    consola.info(`[history/tier2] sealed ${sealed} entries into tier-2 (${count} seal units, ${(bytes / 1048576).toFixed(0)}MB total)`)
    if (count > state.historyArchiveTier2WarnCount)
      consola.warn(`[history/tier2] ${count} seal units exceeds tier2_warn_count=${state.historyArchiveTier2WarnCount} — consider offline archival (files are NEVER auto-deleted)`)
    if (bytes > state.historyArchiveTier2WarnBytes)
      consola.warn(`[history/tier2] tier-2 total ${(bytes / 1048576).toFixed(0)}MB exceeds tier2_warn_bytes — consider offline archival (files are NEVER auto-deleted)`)
  }
  return sealed
}

/**
 * Read a sealed (tier-2) entry back via the manifest locator. Used by the archive
 * VIEW's detail fallback (Phase 4 getEntryById archive-tier miss → here).
 */
export function readTier2Entry(entryId: string): ReturnType<typeof getEntryById> {
  const db = getArchiveDb()
  const row = db.prepare("SELECT seal_file, session_id, index_in_session FROM tier2_manifest WHERE entry_id = ?").get(entryId) as
    | { seal_file: string; session_id: string; index_in_session: number }
    | undefined
  if (!row) return undefined
  const dir = resolveArchiveDir(state.historyArchiveDir, state.historyDbPath)
  return readSealedEntry(path.join(dir, row.seal_file), row.session_id, row.index_in_session)
}

/** Startup-only background seal (T1→T2). Fire-and-forget, never-throws. */
export function startTier2Seal(): void {
  try {
    runTier2SealOnce()
  } catch (err: unknown) {
    consola.warn("[history/tier2] seal pass failed (startup continues)", err)
  }
}
